//! Device-local sync records. All mutations borrow the memory's transaction.
use rusqlite::{params, Connection};

impl crate::McStore {
    /// Short, schema-fenced sync bookkeeping only; callers must do network work outside it.
    pub fn with_memory_sync_write<T>(
        &self,
        write: impl FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<T>,
    ) -> Result<T, crate::McStoreError> {
        self.context_write(&["memory_ops", "memory_outbox", "memory_sync_state"], write)
    }
}

#[allow(clippy::too_many_arguments)]
pub fn append_op(
    conn: &Connection,
    account: &str,
    device: &str,
    local_id: i64,
    event: &super::CreateEvent,
    digest: &str,
    canonical: &[u8],
    now: i64,
) -> rusqlite::Result<()> {
    if conn.is_autocommit() {
        return Err(super::refuse("memory op requires a transaction"));
    }
    conn.execute("INSERT INTO memory_ops(account,device,local_id,memory_id,op_digest,canonical,kind,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![account,device,local_id,event.memory_id,digest,canonical,format!("{:?}",event.kind),now])?;
    Ok(())
}

pub fn enqueue(
    conn: &Connection,
    account: &str,
    device: &str,
    local_id: i64,
) -> rusqlite::Result<()> {
    if conn.is_autocommit() {
        return Err(super::refuse("memory outbox requires a transaction"));
    }
    conn.execute(
        "INSERT INTO memory_outbox(account,device,local_id) VALUES(?1,?2,?3)",
        params![account, device, local_id],
    )?;
    Ok(())
}

pub fn advance(
    conn: &Connection,
    account: &str,
    device: &str,
    next: i64,
    wall_ms: i64,
    logical: i64,
) -> rusqlite::Result<()> {
    if conn.is_autocommit() {
        return Err(super::refuse("memory allocator requires a transaction"));
    }
    conn.execute("INSERT INTO memory_sync_state(device,account,enrollment_state,next_local_id,hlc_wall_ms,hlc_logical) VALUES(?1,?2,'enrolled',?3,?4,?5) ON CONFLICT(device) DO UPDATE SET next_local_id=excluded.next_local_id,hlc_wall_ms=excluded.hlc_wall_ms,hlc_logical=excluded.hlc_logical",params![device,account,next,wall_ms,logical])?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncState {
    pub account: Option<String>,
    pub enrollment_state: String,
    pub next_local_id: i64,
    pub hlc_wall_ms: i64,
    pub hlc_logical: i64,
    pub drainer_holder: Option<String>,
    pub drainer_until: Option<i64>,
}

pub fn sync_state(conn: &Connection, device: &str) -> rusqlite::Result<Option<SyncState>> {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT account,enrollment_state,next_local_id,hlc_wall_ms,hlc_logical,drainer_holder,drainer_until FROM memory_sync_state WHERE device=?1",[device],|r|Ok(SyncState {account:r.get(0)?,enrollment_state:r.get(1)?,next_local_id:r.get(2)?,hlc_wall_ms:r.get(3)?,hlc_logical:r.get(4)?,drainer_holder:r.get(5)?,drainer_until:r.get(6)?})).optional()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedOp {
    pub local_id: i64,
    pub canonical: Vec<u8>,
    pub op_digest: String,
    pub pending_seq: Option<i64>,
    pub last_error: Option<String>,
}

pub fn queued_ops(
    conn: &Connection,
    account: &str,
    device: &str,
) -> rusqlite::Result<Vec<QueuedOp>> {
    conn.prepare("SELECT o.local_id,o.canonical,o.op_digest,q.pending_seq,q.last_error FROM memory_outbox q JOIN memory_ops o USING(account,device,local_id) WHERE q.account=?1 AND q.device=?2 AND q.appended_seq IS NULL ORDER BY q.local_id")?.query_map(params![account,device], |r| Ok(QueuedOp {local_id:r.get(0)?,canonical:r.get(1)?,op_digest:r.get(2)?,pending_seq:r.get(3)?,last_error:r.get(4)?}))?.collect()
}
