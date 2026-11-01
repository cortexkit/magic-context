//! Bounded context.db transactions for background accounting and shared leases.
//! These operations never sample configuration or modify prompt-cache state.

use rusqlite::{params, types::ValueRef, OptionalExtension};

use crate::{McStore, McStoreError};

pub const COMPARTMENT_LEASE_TTL_MS: i64 = 5 * 60 * 1000;
pub const COMPARTMENT_LEASE_RENEWAL_MS: u64 = 60 * 1000;

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct DrainMeta {
    pub protected_tail_drain_window_started_at: i64,
    pub protected_tail_drain_tokens: f64,
    pub emergency_drain_active: i64,
    pub historian_drain_failure_at: i64,
}

fn finite(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<f64> {
    Ok(match row.get_ref(column)? {
        ValueRef::Integer(n) => n as f64,
        ValueRef::Real(n) if n.is_finite() => n,
        _ => 0.0,
    })
}

pub(crate) fn lease_held(
    db: &rusqlite::Connection,
    session: &str,
    holder: &str,
    now: i64,
) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM compartment_state_lease
          WHERE session_id=?1 AND holder_id=?2 AND expires_at>?3)",
        params![session, holder, now],
        |row| row.get(0),
    )
}

impl McStore {
    /// The callback runs once under BEGIN IMMEDIATE. Returning an error rolls back
    /// both the accounting write and creation of a previously absent session row.
    pub fn update_drain_meta<T>(
        &self,
        session: &str,
        apply: impl FnOnce(&mut DrainMeta) -> rusqlite::Result<T>,
    ) -> Result<T, McStoreError> {
        self.context_write(&["session_meta"], |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO session_meta(session_id) VALUES (?1)",
                [session],
            )?;
            let mut meta = tx.query_row(
                "SELECT protected_tail_drain_window_started_at, protected_tail_drain_tokens,
                        emergency_drain_active, historian_drain_failure_at
                   FROM session_meta WHERE session_id=?1",
                [session],
                |row| {
                    Ok(DrainMeta {
                        protected_tail_drain_window_started_at: finite(row, 0)? as i64,
                        protected_tail_drain_tokens: finite(row, 1)?,
                        emergency_drain_active: finite(row, 2)? as i64,
                        historian_drain_failure_at: finite(row, 3)? as i64,
                    })
                },
            )?;
            let value = apply(&mut meta)?;
            if !meta.protected_tail_drain_tokens.is_finite() {
                return Err(rusqlite::Error::InvalidQuery);
            }
            tx.execute(
                "UPDATE session_meta SET protected_tail_drain_window_started_at=?2,
                        protected_tail_drain_tokens=?3, emergency_drain_active=?4,
                        historian_drain_failure_at=?5 WHERE session_id=?1",
                params![
                    session,
                    meta.protected_tail_drain_window_started_at,
                    meta.protected_tail_drain_tokens,
                    meta.emergency_drain_active,
                    meta.historian_drain_failure_at
                ],
            )?;
            Ok(value)
        })
    }

    /// Acquire the per-session writer lock shared by wrapup, recomp and incremental
    /// history. The same holder may reacquire; a different holder waits for expiry
    /// unless the recorded owner's PID is proven dead. A missing or unprobeable PID
    /// is not proof of death.
    pub fn acquire_compartment_lease(
        &self,
        session: &str,
        holder: &str,
        now: i64,
    ) -> Result<bool, McStoreError> {
        if session.is_empty() || holder.is_empty() {
            return Err(crate::single_store_domain::context_error(
                "invalid_lease",
                "empty identity",
            ));
        }
        let blocker = self.context_read(|db| {
            db.query_row(
                "SELECT holder_id, owner_pid, acquired_at, expires_at
                   FROM compartment_state_lease WHERE session_id=?1 AND expires_at>?2",
                params![session, now],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
        })?;
        // Probing a PID may spawn a process. Do it without a database lock, then
        // compare the complete observed row before reclaiming it in the write.
        let dead = blocker.filter(|(_, pid, _, _)| pid.is_some_and(crate::historian_owner_dead));
        self.context_write(&["compartment_state_lease"], |tx| {
            if let Some((owner, Some(pid), acquired, expires)) = dead {
                tx.execute(
                    "DELETE FROM compartment_state_lease WHERE session_id=?1 AND holder_id=?2
                          AND owner_pid=?3 AND acquired_at=?4 AND expires_at=?5",
                    params![session, owner, pid, acquired, expires],
                )?;
            }
            Ok(tx.execute(
                "INSERT INTO compartment_state_lease
                    (session_id, holder_id, owner_pid, acquired_at, expires_at)
                 VALUES (?1,?2,?3,?4,?5) ON CONFLICT(session_id) DO UPDATE SET
                    holder_id=excluded.holder_id, owner_pid=excluded.owner_pid,
                    acquired_at=excluded.acquired_at, expires_at=excluded.expires_at
                 WHERE compartment_state_lease.holder_id=excluded.holder_id
                    OR compartment_state_lease.expires_at<=?4",
                params![
                    session,
                    holder,
                    i64::from(std::process::id()),
                    now,
                    now.saturating_add(COMPARTMENT_LEASE_TTL_MS)
                ],
            )? == 1)
        })
    }

    /// Renewal cannot resurrect an expired lease or extend a successor's hold.
    pub fn renew_compartment_lease(
        &self,
        session: &str,
        holder: &str,
        now: i64,
    ) -> Result<bool, McStoreError> {
        self.context_write(&["compartment_state_lease"], |tx| {
            Ok(tx.execute(
                "UPDATE compartment_state_lease SET acquired_at=?3, expires_at=?4
                  WHERE session_id=?1 AND holder_id=?2 AND expires_at>?3",
                params![
                    session,
                    holder,
                    now,
                    now.saturating_add(COMPARTMENT_LEASE_TTL_MS)
                ],
            )? == 1)
        })
    }

    pub fn owns_compartment_lease(
        &self,
        session: &str,
        holder: &str,
        now: i64,
    ) -> Result<bool, McStoreError> {
        self.context_read(|db| lease_held(db, session, holder, now))
    }

    pub fn release_compartment_lease(
        &self,
        session: &str,
        holder: &str,
    ) -> Result<(), McStoreError> {
        self.context_write(&["compartment_state_lease"], |tx| {
            tx.execute(
                "DELETE FROM compartment_state_lease WHERE session_id=?1 AND holder_id=?2",
                params![session, holder],
            )?;
            Ok(())
        })
    }

    pub fn background_wrapup_in_progress(&self, session: &str) -> Result<bool, McStoreError> {
        self.context_read(|db| crate::historian_wrapup_active(db, session))
    }
}

#[cfg(test)]
#[path = "background_state_tests.rs"]
mod tests;
