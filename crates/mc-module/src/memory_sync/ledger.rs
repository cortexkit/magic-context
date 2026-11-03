//! The device-local sync tables: the ops ck-mc wrote, the queue of ops still
//! to append, and the per-device allocator. Every write
//! borrows the caller's transaction. Ported from the memory-levels card
//! (`crates/mc-store/src/memory_levels/ledger.rs` at `75adf757`).

use rusqlite::{params, Connection, OptionalExtension};

use crate::memory_levels::CreateEvent;

fn in_transaction(conn: &Connection, what: &str) -> rusqlite::Result<()> {
    if conn.is_autocommit() {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
            std::io::Error::other(format!("{what} requires a transaction")),
        )));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn append_op(
    conn: &Connection,
    account: &str,
    device: &str,
    local_id: i64,
    event: &CreateEvent,
    digest: &str,
    canonical: &[u8],
    now: i64,
) -> rusqlite::Result<()> {
    in_transaction(conn, "memory op")?;
    conn.execute(
        "INSERT INTO memory_ops(account, device, local_id, memory_id, op_digest, canonical, kind, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![account, device, local_id, event.memory_id, digest, canonical, format!("{:?}", event.kind), now],
    )?;
    Ok(())
}

pub(super) fn enqueue(
    conn: &Connection,
    account: &str,
    device: &str,
    local_id: i64,
) -> rusqlite::Result<()> {
    in_transaction(conn, "memory outbox")?;
    conn.execute(
        "INSERT INTO memory_outbox(account, device, local_id) VALUES (?1, ?2, ?3)",
        params![account, device, local_id],
    )?;
    Ok(())
}

pub(super) fn advance(
    conn: &Connection,
    account: &str,
    device: &str,
    next: i64,
    wall_ms: i64,
    logical: i64,
) -> rusqlite::Result<()> {
    in_transaction(conn, "memory allocator")?;
    conn.execute(
        "INSERT INTO memory_sync_state(device, account, enrollment_state, next_local_id, hlc_wall_ms, hlc_logical)
         VALUES (?1, ?2, 'enrolled', ?3, ?4, ?5)
         ON CONFLICT(device) DO UPDATE SET next_local_id = excluded.next_local_id,
             hlc_wall_ms = excluded.hlc_wall_ms, hlc_logical = excluded.hlc_logical",
        params![device, account, next, wall_ms, logical],
    )?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SyncState {
    pub next_local_id: i64,
    pub hlc_wall_ms: i64,
    pub hlc_logical: i64,
}

pub(super) fn sync_state(conn: &Connection, device: &str) -> rusqlite::Result<Option<SyncState>> {
    conn.query_row(
        "SELECT next_local_id, hlc_wall_ms, hlc_logical FROM memory_sync_state WHERE device = ?1",
        [device],
        |row| {
            Ok(SyncState {
                next_local_id: row.get(0)?,
                hlc_wall_ms: row.get(1)?,
                hlc_logical: row.get(2)?,
            })
        },
    )
    .optional()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct QueuedOp {
    pub local_id: i64,
    pub canonical: Vec<u8>,
    pub pending_seq: Option<i64>,
    pub last_error: Option<String>,
}

pub(super) fn queued_ops(
    conn: &Connection,
    account: &str,
    device: &str,
) -> rusqlite::Result<Vec<QueuedOp>> {
    conn.prepare(
        "SELECT o.local_id, o.canonical, q.pending_seq, q.last_error
         FROM memory_outbox q JOIN memory_ops o USING(account, device, local_id)
         WHERE q.account = ?1 AND q.device = ?2 AND q.appended_seq IS NULL ORDER BY q.local_id",
    )?
    .query_map(params![account, device], |row| {
        Ok(QueuedOp {
            local_id: row.get(0)?,
            canonical: row.get(1)?,
            pending_seq: row.get(2)?,
            last_error: row.get(3)?,
        })
    })?
    .collect()
}
