//! Append-only replication of newly created assertions. Append acknowledgements
//! update only sync tables, never cached m[0]/m[1], memory epochs or fold requests.
mod account;
mod engram;
mod hlc;
mod jcs;
mod op;
mod outbox;

#[cfg(test)]
mod tests;

use mc_store::memory_levels::{ledger, CreateEvent, CreateHook};
use rusqlite::Connection;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const IDLE_REFRESH: Duration = Duration::from_secs(15 * 60);
const INITIAL_RETRY: Duration = Duration::from_secs(1);
const MAX_RETRY: Duration = Duration::from_secs(30 * 60);

#[derive(Default)]
pub(crate) struct Status {
    last: Mutex<String>,
    unreplicated: Mutex<std::collections::BTreeMap<String, u64>>,
    work: tokio::sync::Notify,
}

impl Status {
    fn set(&self, value: impl Into<String>) {
        *self.last.lock().unwrap() = value.into();
    }
    pub(crate) fn text(&self) -> String {
        self.last.lock().unwrap().clone()
    }
}

pub(crate) fn hook(status: Arc<Status>) -> CreateHook {
    Arc::new(move |conn, event| {
        let outcome = queue(conn, event, crate::now_ms());
        match outcome {
            Ok(Some(reason)) => {
                *status
                    .unreplicated
                    .lock()
                    .unwrap()
                    .entry(reason.into())
                    .or_default() += 1;
                status.set(format!("unreplicated create {}: {reason}", event.memory_id));
            }
            Err(ref e) => status.set(format!("sync storage: {e}")),
            Ok(None) => status.work.notify_one(),
        }
        outcome.map(|_| ())
    })
}

fn queue(
    conn: &Connection,
    event: &CreateEvent,
    now: i64,
) -> rusqlite::Result<Option<&'static str>> {
    if conn.is_autocommit() {
        return Err(mc_store::memory_levels::refuse(
            "memory sync requires a transaction",
        ));
    }
    if event.kind == mc_store::memory_levels::CreateKind::Create
        && (event.owner.is_none() || event.writer_project_id.is_none())
    {
        return Ok(Some("owner_unknown"));
    }
    if !op::eligible(event) {
        return Ok(Some("not_eligible"));
    }
    let Some(account) = account::cached(conn)? else {
        return Ok(Some("unknown"));
    };
    if account.state != "enrolled" {
        return Ok(Some(match account.state.as_str() {
            "not_enrolled" => "not_enrolled",
            "credential_invalid" => "credential_invalid",
            _ => "unknown",
        }));
    }
    let state = ledger::sync_state(conn, &account.device)?.unwrap();
    let Some(clock) = hlc::next(now, state.hlc_wall_ms, state.hlc_logical) else {
        return Ok(Some("op_unmappable"));
    };
    let Some(next) = state.next_local_id.checked_add(1) else {
        return Ok(Some("op_unmappable"));
    };
    let bytes = match op::map(
        event,
        &account.account,
        &account.device,
        state.next_local_id,
        clock,
    ) {
        Ok(bytes) => bytes,
        Err(reason) => return Ok(Some(reason)),
    };
    ledger::append_op(
        conn,
        &account.account,
        &account.device,
        state.next_local_id,
        event,
        &jcs::digest(&bytes),
        &bytes,
        now,
    )?;
    ledger::enqueue(conn, &account.account, &account.device, state.next_local_id)?;
    ledger::advance(
        conn,
        &account.account,
        &account.device,
        next,
        clock.0,
        clock.1,
    )?;
    Ok(None)
}

pub(crate) struct Service {
    wire: Option<engram::Wire>,
    status: Arc<Status>,
}

impl Service {
    pub(crate) fn new(file: Option<std::path::PathBuf>, module_id: String) -> Arc<Self> {
        Arc::new(Self {
            wire: file.map(|file| engram::Wire { file, module_id }),
            status: Arc::default(),
        })
    }

    pub(crate) fn install(self: &Arc<Self>, store: &Arc<mc_store::McStore>) {
        store.set_memory_create_hook(Some(hook(self.status.clone())));
        let Some(wire) = self.wire.clone() else {
            return;
        };
        tokio::spawn(Self::run(Arc::downgrade(self), Arc::downgrade(store), wire));
    }

    async fn run<E: engram::Engram>(
        service: std::sync::Weak<Self>,
        store: std::sync::Weak<mc_store::McStore>,
        wire: E,
    ) {
        let holder = format!("{}-{}", std::process::id(), crate::now_ms());
        let mut retry = INITIAL_RETRY;
        loop {
            let (Some(current), Some(active_store)) = (service.upgrade(), store.upgrade()) else {
                return;
            };
            let status = current.status.clone();
            let mut result = current.cycle_with(&wire, &active_store, &holder).await;
            let (inactive, pending) = match Self::scheduling_state(&active_store) {
                Ok(state) => state,
                Err(error) => {
                    result = Err(error);
                    (false, true)
                }
            };
            if let Err(error) = result.as_ref() {
                status.set(error);
            }
            let delay = if inactive {
                retry = MAX_RETRY;
                MAX_RETRY
            } else if result.is_ok() && !pending {
                retry = INITIAL_RETRY;
                IDLE_REFRESH
            } else {
                let delay = retry;
                retry = retry.saturating_mul(2).min(MAX_RETRY);
                delay
            };
            drop(current);
            drop(active_store);
            let deadline = tokio::time::Instant::now() + delay;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep_until(deadline) => break,
                    _ = status.work.notified() => {
                        let Some(active_store) = store.upgrade() else { return; };
                        match Self::scheduling_state(&active_store) {
                            Ok((_, true)) => break,
                            // A signal may describe work the last cycle already drained
                            // or a rolled-back create. Neither warrants a stream.heads refresh.
                            Ok((_, false)) => {},
                            Err(error) => { status.set(error); break; }
                        }
                    }
                }
            }
        }
    }

    fn scheduling_state(store: &mc_store::McStore) -> Result<(bool, bool), String> {
        // The hook signals inside the create transaction. Serialize this read
        // with its commit before deciding whether the notification has work.
        store.with_memory_sync_write(|conn| {
            let Some(account) = account::cached(conn)? else { return Ok((false, false)); };
            let inactive = matches!(account.state.as_str(), "not_enrolled" | "credential_invalid");
            let pending = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_outbox WHERE account=?1 AND device=?2 AND appended_seq IS NULL AND coalesce(last_error,'')!='seq_reused')",
                rusqlite::params![account.account,account.device], |row| row.get(0),
            )?;
            Ok((inactive, pending))
        }).map_err(|error| error.to_string())
    }

    async fn cycle_with<E: engram::Engram>(
        &self,
        wire: &E,
        store: &mc_store::McStore,
        holder: &str,
    ) -> Result<(), String> {
        // An uncertain batch owns its sequence. The stream.heads refresh below
        // must wait until that exact batch has been retried after a lost ack.
        let uncertain = store.with_memory_sync_write(|conn|conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_outbox q JOIN memory_sync_state s USING(device) WHERE s.enrollment_state='enrolled' AND q.pending_seq IS NOT NULL AND q.appended_seq IS NULL)",[],|r|r.get::<_,bool>(0))).map_err(|e|e.to_string())?;
        if !uncertain {
            let heads = wire.heads().await;
            store
                .with_memory_sync_write(|conn| account::refresh(conn, &heads))
                .map_err(|e| e.to_string())?;
            if let Err(error) = heads {
                self.status.set(&error);
                return Err(error);
            }
        }
        let tx = |f: &mut dyn FnMut(&Connection) -> rusqlite::Result<()>| {
            store
                .with_memory_sync_write(|conn| f(conn))
                .map_err(|e| e.to_string())
        };
        let result = outbox::drain(wire, tx, holder, crate::now_ms()).await;
        if let Err(error) = &result {
            store
                .with_memory_sync_write(|conn| account::refresh(conn, &Err(error.clone())))
                .map_err(|e| e.to_string())?;
        }
        result
    }

    pub(crate) fn status(&self, store: &mc_store::McStore) -> serde_json::Value {
        let records = store.with_context_read(|conn| {
            let cached = account::cached(conn)?;
            let queued: i64 = conn.query_row("SELECT count(*) FROM memory_outbox WHERE appended_seq IS NULL AND coalesce(last_error,'')!='seq_reused'",[],|r|r.get(0))?;
            let terminal: i64 = conn.query_row("SELECT count(*) FROM memory_outbox WHERE last_error='seq_reused'",[],|r|r.get(0))?;
            let error: Option<String> = conn.query_row("SELECT max(last_error) FROM memory_outbox WHERE appended_seq IS NULL",[],|r|r.get(0))?;
            let unknown_owner: i64 = conn.query_row("SELECT count(*) FROM memories m WHERE NOT EXISTS(SELECT 1 FROM memory_placement p WHERE p.memory_id=m.id)",[],|r|r.get(0))?;
            let unknown_ids: Vec<i64> = conn.prepare("SELECT m.id FROM memories m WHERE NOT EXISTS(SELECT 1 FROM memory_placement p WHERE p.memory_id=m.id) ORDER BY m.id DESC LIMIT 20")?.query_map([],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?;
            Ok((cached,queued,terminal,error,unknown_owner,unknown_ids))
        });
        match records {
            Ok((cached, queued, terminal, error, unknown_owner, unknown_ids)) => {
                serde_json::json!({"state":cached.map(|a|a.state).unwrap_or("unknown".into()),"queued":queued,"seq_reused":terminal,"last_error":error,"last_status":self.status.text(),"unreplicated_since_start":*self.status.unreplicated.lock().unwrap(),"owner_unknown_count":unknown_owner,"owner_unknown_memory_ids":unknown_ids})
            }
            Err(error) => serde_json::json!({"state":"unknown","last_status":error.to_string()}),
        }
    }
}
