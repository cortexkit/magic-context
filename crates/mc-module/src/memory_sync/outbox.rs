use super::{account, engram::Engram};
use mc_store::memory_levels::ledger;
use rusqlite::{params, Connection};

const LEASE_MS: i64 = 60_000;

pub(super) fn claim(
    conn: &Connection,
    device: &str,
    holder: &str,
    now: i64,
) -> rusqlite::Result<bool> {
    Ok(conn.execute("UPDATE memory_sync_state SET drainer_holder=?1,drainer_until=?2 WHERE device=?3 AND (drainer_holder IS NULL OR drainer_until<=?4)", params![holder,now+LEASE_MS,device,now])? == 1)
}

pub(super) fn release(conn: &Connection, device: &str, holder: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE memory_sync_state SET drainer_holder=NULL,drainer_until=NULL WHERE device=?1 AND drainer_holder=?2",params![device,holder])?;
    Ok(())
}

// One-entry batches freeze membership as well as bytes across an uncertain append.
// Later queued creates cannot accidentally join a batch already sent before a crash.
pub(super) async fn drain<E: Engram, F>(
    transport: &E,
    transaction: F,
    holder: &str,
    now: i64,
) -> Result<(), String>
where
    F: Fn(&mut dyn FnMut(&Connection) -> rusqlite::Result<()>) -> Result<(), String>,
{
    let mut cached = None;
    transaction(&mut |conn| {
        cached = account::cached(conn)?;
        Ok(())
    })
    .map_err(|e| e.to_string())?;
    let Some(account) = cached.filter(|a| a.state == "enrolled") else {
        return Ok(());
    };
    let mut acquired = false;
    transaction(&mut |conn| {
        acquired = claim(conn, &account.device, holder, now)?;
        Ok(())
    })
    .map_err(|e| e.to_string())?;
    if !acquired {
        return Ok(());
    }
    let result = drain_claimed(transport, &transaction, &account, holder, now).await;
    transaction(&mut |conn| release(conn, &account.device, holder)).map_err(|e| e.to_string())?;
    result
}

async fn drain_claimed<E: Engram, F>(
    transport: &E,
    transaction: &F,
    account: &account::Account,
    holder: &str,
    now: i64,
) -> Result<(), String>
where
    F: Fn(&mut dyn FnMut(&Connection) -> rusqlite::Result<()>) -> Result<(), String>,
{
    let started = std::time::Instant::now();
    let mut queued = Vec::new();
    transaction(&mut |conn| {
        queued = ledger::queued_ops(conn, &account.account, &account.device)?;
        Ok(())
    })
    .map_err(|e| e.to_string())?;
    for op in queued
        .into_iter()
        .filter(|q| q.last_error.as_deref() != Some("seq_reused"))
    {
        let mut seq = op.pending_seq;
        for _ in 0..2 {
            let mut held = false;
            transaction(&mut |conn| {
                // Renew before each bounded network attempt, including long queues.
                // A stolen/expired lease must not let an old drainer send another op.
                let current =
                    now.saturating_add(started.elapsed().as_millis().min(i64::MAX as u128) as i64);
                held = conn.execute("UPDATE memory_sync_state SET drainer_until=?1 WHERE device=?2 AND drainer_holder=?3 AND drainer_until>?4",params![current+LEASE_MS,account.device,holder,current])? == 1;
                Ok(())
            })?;
            if !held {
                return Err("lease_lost".into());
            }
            let pending = match seq {
                Some(seq) => seq,
                None => {
                    let heads = transport.heads().await?;
                    if heads.account != account.account || heads.device != account.device {
                        return Err("identity_changed".into());
                    }
                    heads.head.checked_add(1).ok_or("sequence_exhausted")?
                }
            };
            transaction(&mut |conn| {
                conn.execute("UPDATE memory_outbox SET pending_seq=?1 WHERE account=?2 AND device=?3 AND local_id=?4",params![pending,account.account,account.device,op.local_id])?;
                Ok(())
            }).map_err(|e|e.to_string())?;
            let result = transport.append(pending, &op.canonical).await;
            let error = result.as_ref().err().cloned();
            transaction(&mut |conn| {
                match &result {
                    Ok(end) if *end == pending => {
                        conn.execute("UPDATE memory_outbox SET appended_seq=?1,pending_seq=NULL,last_error=NULL WHERE account=?2 AND device=?3 AND local_id=?4",params![end,account.account,account.device,op.local_id])?;
                    }
                    _ => {
                        let error = error.as_deref().unwrap_or("invalid_ack");
                        conn.execute("UPDATE memory_outbox SET last_error=?1,pending_seq=CASE WHEN ?1 IN ('seq_moved','seq_reused') THEN NULL ELSE pending_seq END WHERE account=?2 AND device=?3 AND local_id=?4",params![error,account.account,account.device,op.local_id])?;
                    }
                }
                Ok(())
            }).map_err(|e|e.to_string())?;
            match result {
                Ok(end) if end == pending => break,
                Err(ref e) if e == "seq_moved" => {
                    seq = None;
                }
                Err(ref e) if e == "seq_reused" => break,
                Err(e) => return Err(e),
                _ => return Err("invalid_ack".into()),
            }
        }
        // An unresolved seq_moved cannot be overtaken by a later local op.
        let mut unresolved = false;
        transaction(&mut |conn| {
            unresolved = conn.query_row("SELECT appended_seq IS NULL AND coalesce(last_error,'') != 'seq_reused' FROM memory_outbox WHERE account=?1 AND device=?2 AND local_id=?3",params![account.account,account.device,op.local_id],|r|r.get(0))?;
            Ok(())
        }).map_err(|e|e.to_string())?;
        if unresolved {
            return Err("seq_moved".into());
        }
    }
    Ok(())
}
