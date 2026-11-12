//! Durable, ordered write plans for an offline session move in a shared store.
//!
//! Discovery and number conversion run without a write lock. Before changing
//! session rows, the complete plan is staged in metadata in small transactions.
//! Each application transaction consumes consecutive plan units and advances
//! its cursor atomically. A retry reads saved targets, never partially converted
//! rows. Commit groups grow by measured write time and yield between locks.

use rusqlite::types::{ToSqlOutput, ValueRef};
use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, ToSql, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;

mod checkpoints;
mod fts;
/// How long one write transaction of the mover keeps adding work; the
/// install's lock measurement reports it beside its transactions.
#[cfg(all(test, feature = "context-db-timing"))]
pub(crate) use checkpoints::WRITE_WINDOW;
pub(crate) use fts::ordinal_update;

const BATCH_WRITES: usize = 32;
const DISCOVERY_ROWS: usize = 512;

// Tests can fix the write-loop clock; production always reads the real clock.
#[cfg(not(test))]
fn write_window_open(started: std::time::Instant) -> bool {
    started.elapsed() < checkpoints::WRITE_WINDOW
}

#[cfg(test)]
fn write_window_open(started: std::time::Instant) -> bool {
    crate::move_in::tests::writer::write_window_open(started, checkpoints::WRITE_WINDOW)
}

pub(crate) fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Completed backfills provide an indexed session -> FTS rowid lookup. Older
/// stores may contain unmapped rows: walk bounded rowid pages in autocommit
/// mode, releasing each read snapshot before reading the next page.
pub(crate) fn message_rows(
    conn: &Connection,
    session: &str,
) -> rusqlite::Result<Vec<(i64, String)>> {
    let mapped = conn
        .query_row(
            "SELECT completed FROM message_fts_rowid_map_backfill_state WHERE id=1",
            [],
            |r| r.get::<_, bool>(0),
        )
        .optional()?
        .unwrap_or(false);
    if mapped {
        let mut found = Vec::new();
        let mut cursor = i64::MIN;
        let mut relation = ">=";
        loop {
            let rows: Vec<(i64, String)> = conn
                .prepare(&format!(
                    "SELECT f.rowid, f.message_id FROM message_fts_rowid_map m
                JOIN message_history_fts f ON f.rowid=m.fts_rowid
                WHERE m.session_id=?1 AND f.session_id=?1 AND m.fts_rowid {relation} ?2
                ORDER BY m.fts_rowid LIMIT {DISCOVERY_ROWS}"
                ))?
                .query_map(params![session, cursor], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<Result<_, _>>()?;
            if rows.is_empty() {
                break;
            }
            cursor = rows.last().unwrap().0;
            relation = ">";
            found.extend(rows);
        }
        return Ok(found);
    }
    let mut found = Vec::new();
    let mut cursor = i64::MIN;
    let mut relation = ">=";
    loop {
        let rows: Vec<(i64, String, String)> = conn.prepare(&format!(
            "SELECT rowid, session_id, message_id FROM message_history_fts WHERE rowid {relation} ?1 ORDER BY rowid LIMIT {DISCOVERY_ROWS}"))?
            .query_map(params![cursor], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?.collect::<Result<_,_>>()?;
        if rows.is_empty() {
            break;
        }
        cursor = rows.last().unwrap().0;
        relation = ">";
        found.extend(
            rows.into_iter()
                .filter(|(_, owner, _)| owner == session)
                .map(|(id, _, mid)| (id, mid)),
        );
    }
    Ok(found)
}

pub(crate) fn session_tables(conn: &Connection) -> Result<Vec<String>, String> {
    conn.prepare(
        "SELECT m.name FROM sqlite_master m WHERE m.type='table'
        AND EXISTS(SELECT 1 FROM pragma_table_info(m.name) WHERE name='session_id')
        AND EXISTS(SELECT 1 FROM pragma_table_info(m.name) WHERE name='harness') ORDER BY m.name",
    )
    .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect())
    .map_err(|e| e.to_string())
}

/// Use a session index when one exists. Virtual tables have no ordinary
/// session index, so discover them by bounded rowid pages, never a predicate
/// scan of the full-text virtual table for every write batch.
pub(crate) fn harness_rows(
    conn: &Connection,
    table: &str,
    session: &str,
) -> Result<Vec<(i64, String)>, String> {
    let indexed: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_index_list(?1) l
        JOIN pragma_index_info(l.name) i WHERE i.seqno=0 AND i.name='session_id' AND l.partial=0)",
            params![table],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let table = quoted(table);
    if indexed {
        return conn
            .prepare(&format!(
                "SELECT rowid, harness FROM {table} WHERE session_id=?1 ORDER BY rowid"
            ))
            .and_then(|mut s| {
                s.query_map(params![session], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect()
            })
            .map_err(|e| e.to_string());
    }
    let mut found = Vec::new();
    let mut cursor = i64::MIN;
    let mut relation = ">=";
    loop {
        let rows: Vec<(i64,String,String)> = conn.prepare(&format!("SELECT rowid,session_id,harness FROM {table} WHERE rowid {relation} ?1 ORDER BY rowid LIMIT {DISCOVERY_ROWS}"))
            .and_then(|mut s| s.query_map(params![cursor], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect()).map_err(|e| e.to_string())?;
        if rows.is_empty() {
            break;
        }
        cursor = rows.last().unwrap().0;
        relation = ">";
        found.extend(
            rows.into_iter()
                .filter(|(_, owner, _)| owner == session)
                .map(|(id, _, harness)| (id, harness)),
        );
    }
    Ok(found)
}

#[derive(Serialize, Deserialize)]
struct Write {
    sql: String,
    args: Vec<Value>,
}

#[derive(Serialize, Deserialize)]
struct Batch {
    phase: String,
    writes: Vec<Write>,
}

#[derive(Default)]
pub(crate) struct Plan {
    phase: RefCell<String>,
    batches: RefCell<Vec<Batch>>,
}

impl Plan {
    pub(crate) fn phase(&self, phase: &str) {
        *self.phase.borrow_mut() = phase.into();
    }

    /// Record bound values rather than interpolating data into SQL. Plans use
    /// only text, integer and null values; blobs never need to be copied.
    pub(crate) fn execute(&self, sql: &str, args: &[&dyn ToSql]) -> rusqlite::Result<usize> {
        let args = args
            .iter()
            .map(|arg| {
                let value = arg.to_sql()?;
                let value = match &value {
                    ToSqlOutput::Borrowed(value) => *value,
                    ToSqlOutput::Owned(value) => ValueRef::from(value),
                    _ => return Err(rusqlite::Error::InvalidQuery),
                };
                match value {
                    ValueRef::Null => Ok(Value::Null),
                    ValueRef::Integer(n) => Ok(n.into()),
                    ValueRef::Text(text) => Ok(String::from_utf8_lossy(text).into_owned().into()),
                    _ => Err(rusqlite::Error::InvalidQuery),
                }
            })
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let phase = self.phase.borrow();
        let mut batches = self.batches.borrow_mut();
        if batches
            .last()
            .is_none_or(|batch| batch.phase != *phase || batch.writes.len() == BATCH_WRITES)
        {
            batches.push(Batch {
                phase: phase.clone(),
                writes: Vec::new(),
            });
        }
        batches.last_mut().unwrap().writes.push(Write {
            sql: sql.into(),
            args,
        });
        Ok(0)
    }

    pub(crate) fn stage(
        self,
        conn: &mut Connection,
        key: &str,
        mut record: Value,
    ) -> Result<(), String> {
        let batches = self.batches.into_inner();
        let total = batches.len();
        record["state"] = "staging".into();
        record["batches"] = batches.len().into();
        record["next"] = 0.into();
        // An incomplete staging pass has changed no session rows and can be
        // rebuilt. Publish 'applying' only after every batch is durable.
        let mut writer = checkpoints::Writer::new(conn)?;
        writer.transaction("stage/start", |tx| save(tx, key, &record))?;
        let mut source = batches.into_iter().enumerate();
        let mut pending = std::collections::VecDeque::new();
        let mut staged = 0;
        while staged < total {
            let limit = writer.limit("stage/batch");
            while pending.len() < limit {
                let Some((index, batch)) = source.next() else {
                    break;
                };
                pending.push_back((
                    index,
                    serde_json::to_string(&batch).map_err(|e| e.to_string())?,
                ));
            }
            staged += writer.grouped("stage/batch", |tx| {
                let started = std::time::Instant::now();
                let mut count = 0;
                while count < limit && (count == 0 || write_window_open(started)) {
                    let Some((index, body)) = pending.pop_front() else {
                        break;
                    };
                    tx.execute(
                        "INSERT OR REPLACE INTO schema_migrations_meta(key,value) VALUES (?1,?2)",
                        params![batch_key(key, index), body],
                    )
                    .map_err(|e| e.to_string())?;
                    count += 1;
                }
                Ok(count)
            })?;
        }
        record["state"] = "applying".into();
        writer.transaction("stage/ready", |tx| save(tx, key, &record))?;
        writer.finish()?;
        drop(writer);
        resume(conn, key)?;
        Ok(())
    }
}

fn batch_key(key: &str, index: usize) -> String {
    format!("mode3_batch:{key}:{index:08}")
}

pub(crate) fn record(conn: &Connection, key: &str) -> Result<Option<Value>, String> {
    conn.query_row(
        "SELECT value FROM schema_migrations_meta WHERE key=?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|text| {
        serde_json::from_str(&text).map_err(|e| format!("move_progress_invalid: {key}: {e}"))
    })
    .transpose()
}

fn save(conn: &Connection, key: &str, record: &Value) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO schema_migrations_meta(key,value) VALUES (?1,?2)",
        params![key, record.to_string()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// False means staging was interrupted: it is safe to rediscover original
/// rows. Legacy checksum-only records already describe a completed move.
pub(crate) fn resume(conn: &mut Connection, key: &str) -> Result<bool, String> {
    let Some(mut progress) = record(conn, key)? else {
        return Ok(false);
    };
    if progress["state"] == "staging" {
        return Ok(false);
    }
    if progress["state"] != "applying" {
        return Ok(true);
    }
    let total = progress["batches"]
        .as_u64()
        .ok_or("move_progress_invalid: batches")? as usize;
    let mut next = progress["next"]
        .as_u64()
        .ok_or("move_progress_invalid: next")? as usize;
    // A retry may follow a global schema migration. Saved absolute ordinals
    // are still valid, but their physical FTS update path must be revalidated.
    let ordinal_update = fts::ordinal_update(conn).map_err(|e| e.to_string())?;
    let mut writer = checkpoints::Writer::new(conn)?;
    let mut pending = std::collections::VecDeque::<(usize, Batch)>::new();
    let mut loaded = next;
    while next < total {
        if pending.is_empty() {
            pending.push_back((loaded, read_batch(&writer, key, loaded)?));
            loaded += 1;
        }
        let phase = pending.front().unwrap().1.phase.clone();
        let limit = writer.limit(&phase);
        while loaded < total && pending.len() < limit && pending.back().unwrap().1.phase == phase {
            pending.push_back((loaded, read_batch(&writer, key, loaded)?));
            loaded += 1;
        }
        let expected = progress.clone();
        let completed = writer.grouped(&phase, |tx| {
            if record(tx, key)?.as_ref() != Some(&expected) {
                return Err("move_in_progress: another mover advanced the session; retry".into());
            }
            let started = std::time::Instant::now();
            let mut count = 0;
            while count < limit
                && pending
                    .front()
                    .is_some_and(|(_, batch)| batch.phase == phase)
                && (count == 0 || write_window_open(started))
            {
                let (index, batch) = pending.pop_front().unwrap();
                for mut write in batch.writes {
                    if fts::is_ordinal_update(&write.sql) {
                        write.sql = ordinal_update.into();
                    }
                    let args = write.args.into_iter().map(|value| match value {
                        Value::Null => rusqlite::types::Value::Null,
                        Value::Number(n) => rusqlite::types::Value::Integer(n.as_i64().unwrap()),
                        Value::String(s) => rusqlite::types::Value::Text(s),
                        _ => unreachable!("plan values are text, integer or null"),
                    });
                    tx.prepare_cached(&write.sql)
                        .and_then(|mut s| s.execute(params_from_iter(args)))
                        .map_err(|e| e.to_string())?;
                }
                tx.execute(
                    "DELETE FROM schema_migrations_meta WHERE key=?1",
                    params![batch_key(key, index)],
                )
                .map_err(|e| e.to_string())?;
                count += 1;
            }
            progress["next"] = (next + count).into();
            save(tx, key, &progress)?;
            Ok(count)
        })?;
        next += completed;
    }
    progress["state"] = "done".into();
    writer.transaction("finish", |tx| save(tx, key, &progress))?;
    writer.finish()?;
    Ok(true)
}

fn read_batch(conn: &Connection, key: &str, index: usize) -> Result<Batch, String> {
    let body: String = conn
        .query_row(
            "SELECT value FROM schema_migrations_meta WHERE key=?1",
            params![batch_key(key, index)],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

/// Time only the transaction, not a bulk writer's subsequent PASSIVE checkpoint.
/// Bulk stages own checkpointing between batches, rather than transferring their
/// WAL backlog to a host's automatic checkpoint on its next commit. The final
/// marker telling the standalone plugin the session has moved, and other
/// standalone writes, retain their automatic checkpoint policy.
pub(crate) fn transaction<T>(
    conn: &mut Connection,
    phase: &str,
    write: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    transaction_measured(conn, phase, write).map(|(value, _)| value)
}

fn transaction_measured<T>(
    conn: &mut Connection,
    phase: &str,
    write: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<(T, std::time::Duration), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
    #[cfg(feature = "context-db-timing")]
    let changes = tx.total_changes();
    #[cfg(test)]
    let measure = crate::move_in::tests::Measure::new(phase);
    let result = match write(&tx) {
        Ok(value) => tx.commit().map(|()| value).map_err(|e| e.to_string()),
        Err(error) => {
            tx.rollback().map_err(|e| e.to_string())?;
            Err(error)
        }
    };
    let held = started.elapsed();
    #[cfg(test)]
    drop(measure);
    #[cfg(feature = "context-db-timing")]
    crate::context_db::timing::transaction(phase, conn.total_changes() - changes, held);
    let result = result?;
    #[cfg(test)]
    crate::move_in::tests::after_commit(phase)?;
    #[cfg(test)]
    crate::agent_data::crash::after_commit(phase)?;
    let _ = phase;
    Ok((result, held))
}
