//! Durable, ordered write plans for an offline session move in a shared store.
//!
//! Discovery and number conversion run without a write lock. Before changing
//! session rows, the complete plan is staged in metadata in small transactions.
//! Each application transaction consumes one batch and advances its cursor
//! atomically. A retry reads the saved targets, never partially converted rows.

use rusqlite::types::{ToSqlOutput, ValueRef};
use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, ToSql, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;

mod fts;
pub(crate) use fts::ordinal_update;

const BATCH_WRITES: usize = 32;
const DISCOVERY_ROWS: usize = 512;

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
        record["state"] = "staging".into();
        record["batches"] = batches.len().into();
        record["next"] = 0.into();
        // An incomplete staging pass has changed no session rows and can be
        // rebuilt. Publish 'applying' only after every batch is durable.
        transaction(conn, "stage/start", |tx| save(tx, key, &record))?;
        for (index, batch) in batches.into_iter().enumerate() {
            let body = serde_json::to_string(&batch).map_err(|e| e.to_string())?;
            transaction(conn, "stage/batch", |tx| {
                tx.execute(
                    "INSERT OR REPLACE INTO schema_migrations_meta(key,value) VALUES (?1,?2)",
                    params![batch_key(key, index), body],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })?;
        }
        record["state"] = "applying".into();
        transaction(conn, "stage/ready", |tx| save(tx, key, &record))?;
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
    while next < total {
        let body: String = conn
            .query_row(
                "SELECT value FROM schema_migrations_meta WHERE key=?1",
                params![batch_key(key, next)],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let batch: Batch = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let expected = progress.clone();
        progress["next"] = (next + 1).into();
        transaction(conn, &batch.phase, |tx| {
            if record(tx, key)?.as_ref() != Some(&expected) {
                return Err("move_in_progress: another mover advanced the session; retry".into());
            }
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
            save(tx, key, &progress)?;
            tx.execute(
                "DELETE FROM schema_migrations_meta WHERE key=?1",
                params![batch_key(key, next)],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })?;
        next += 1;
    }
    progress["state"] = "done".into();
    transaction(conn, "finish", |tx| save(tx, key, &progress))?;
    Ok(true)
}

/// Automatic WAL checkpoints can turn a tiny commit into a whole-store I/O
/// operation. Leave checkpointing to SQLite's other connections, outside this
/// writer's critical section, and restore the caller's connection policy.
pub(crate) fn transaction<T>(
    conn: &mut Connection,
    phase: &str,
    write: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let checkpoint: i64 = conn
        .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "wal_autocheckpoint", 0)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        #[cfg(test)]
        let measure = crate::move_in::tests::Measure::new(phase);
        let result = match write(&tx) {
            Ok(value) => tx.commit().map(|()| value).map_err(|e| e.to_string()),
            Err(error) => {
                tx.rollback().map_err(|e| e.to_string())?;
                Err(error)
            }
        };
        #[cfg(test)]
        drop(measure);
        let result = result?;
        #[cfg(test)]
        crate::move_in::tests::after_commit(phase)?;
        Ok(result)
    })();
    conn.pragma_update(None, "wal_autocheckpoint", checkpoint)
        .map_err(|e| e.to_string())?;
    let _ = phase;
    result
}
