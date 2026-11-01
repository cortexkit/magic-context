//! Prevent concurrent Rust and TypeScript dream tasks from writing the same domain
//! by sharing lease rows in context.db's existing dream_state table.

use crate::{McStore, McStoreError};
use rusqlite::{params, Connection, OptionalExtension, Transaction};

pub const LEASE_DURATION_MS: i64 = 120_000;
pub const HEARTBEAT_INTERVAL_MS: u64 = 40_000;
const MAX_GENERATION: u64 = 9_007_199_254_740_991;

/// Identifies one holder of a dream-task conflict domain. This does not grant
/// compartment publication rights. Writers check holder and generation inside
/// their write transaction so a successor's lease cannot authorize stale effects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DreamDomainLease {
    pub key: String,
    pub holder: String,
    pub generation: u64,
    pub expires_at_ms: i64,
}

/// Durable timing of the current domain holder. A release deletes this record;
/// callers must not interpret its absence as proof that remote work has stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DreamDomainTiming {
    pub holder: String,
    pub generation: u64,
    pub renewed_at_ms: i64,
    pub expires_at_ms: i64,
}

fn row_key(key: &str, field: &str) -> String {
    if key == "dreaming" {
        format!("dreaming_lease_{field}")
    } else {
        format!("lease:{key}:{field}")
    }
}

fn get(db: &Connection, key: &str, field: &str) -> rusqlite::Result<Option<String>> {
    db.query_row(
        "SELECT value FROM dream_state WHERE key=?1",
        [row_key(key, field)],
        |r| r.get(0),
    )
    .optional()
}

fn set(db: &Connection, key: &str, field: &str, value: &str) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO dream_state(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![row_key(key, field), value],
    )?;
    Ok(())
}

fn number(value: Option<String>) -> Option<f64> {
    value.and_then(|v| v.trim().parse::<f64>().ok().filter(|n| n.is_finite()))
}

fn generation(db: &Connection, key: &str) -> rusqlite::Result<u64> {
    Ok(number(get(db, key, "generation")?)
        .filter(|n| *n > 0.0 && *n <= MAX_GENERATION as f64 && n.fract() == 0.0)
        .map_or(0, |n| n as u64))
}

fn held(db: &Connection, lease: &DreamDomainLease, now_ms: i64) -> rusqlite::Result<bool> {
    Ok(
        get(db, &lease.key, "holder")?.as_deref() == Some(&lease.holder)
            && lease.generation > 0
            && generation(db, &lease.key)? == lease.generation
            && number(get(db, &lease.key, "expiry")?).is_some_and(|e| e > now_ms as f64),
    )
}

/// Call inside the SAME BEGIN IMMEDIATE transaction that applies task effects.
/// Checking through a separate connection before entering the transaction leaves
/// a race in which another runtime can replace the lease before the write.
pub fn owns_tx(
    tx: &Transaction<'_>,
    lease: &DreamDomainLease,
    now_ms: i64,
) -> rusqlite::Result<bool> {
    held(tx, lease, now_ms)
}

/// Refuse the entire effect batch if the domain expired or a successor owns it.
/// Returning this error through the store's transaction callback rolls back writes.
pub fn require_tx(
    tx: &Transaction<'_>,
    lease: &DreamDomainLease,
    now_ms: i64,
) -> rusqlite::Result<()> {
    if owns_tx(tx, lease, now_ms)? {
        Ok(())
    } else {
        Err(rusqlite::Error::InvalidQuery)
    }
}

impl McStore {
    /// Read the existing heartbeat/expiry rows without acquiring or renewing a lease.
    pub fn dream_domain_timing(
        &self,
        key: &str,
    ) -> Result<Option<DreamDomainTiming>, McStoreError> {
        self.context_read(|db| {
            let holder = get(db, key, "holder")?;
            let heartbeat = get(db, key, "heartbeat")?;
            let expiry = get(db, key, "expiry")?;
            if holder.is_none() && heartbeat.is_none() && expiry.is_none() {
                return Ok(None);
            }
            let timestamp = |value: Option<String>| {
                number(value)
                    .filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n <= i64::MAX as f64)
                    .map(|n| n as i64)
                    .ok_or(rusqlite::Error::InvalidQuery)
            };
            let renewed_at_ms = timestamp(heartbeat)?;
            let expires_at_ms = timestamp(expiry)?;
            let holder = holder
                .filter(|h| !h.is_empty())
                .ok_or(rusqlite::Error::InvalidQuery)?;
            let generation = generation(db, key)?;
            if generation == 0 || expires_at_ms < renewed_at_ms {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(Some(DreamDomainTiming {
                holder,
                generation,
                renewed_at_ms,
                expires_at_ms,
            }))
        })
    }

    /// Share the plugin's two-minute lease and generation protocol. Use a unique
    /// holder for each dispatcher attempt; an existing holder may refresh its lease.
    /// This transaction must complete before claiming the independent scheduler.
    pub fn acquire_dream_domain(
        &self,
        key: &str,
        holder: &str,
        now_ms: i64,
    ) -> Result<Option<DreamDomainLease>, McStoreError> {
        self.context_write(&["dream_state"], |tx| {
            if key.is_empty()
                || holder.is_empty()
                || now_ms.checked_add(LEASE_DURATION_MS).is_none()
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let prior_holder = get(tx, key, "holder")?;
            let active = number(get(tx, key, "expiry")?).is_some_and(|e| e > now_ms as f64);
            if active
                && prior_holder
                    .as_deref()
                    .is_some_and(|h| !h.is_empty() && h != holder)
            {
                return Ok(None);
            }
            let prior_generation = generation(tx, key)?;
            let generation = if prior_holder.as_deref() == Some(holder) {
                prior_generation.max(1)
            } else {
                prior_generation + 1
            };
            if generation > MAX_GENERATION {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let expires_at_ms = now_ms + LEASE_DURATION_MS;
            set(tx, key, "holder", holder)?;
            set(tx, key, "heartbeat", &now_ms.to_string())?;
            set(tx, key, "expiry", &expires_at_ms.to_string())?;
            set(tx, key, "generation", &generation.to_string())?;
            Ok(Some(DreamDomainLease {
                key: key.into(),
                holder: holder.into(),
                generation,
                expires_at_ms,
            }))
        })
    }

    pub fn owns_dream_domain(
        &self,
        lease: &DreamDomainLease,
        now_ms: i64,
    ) -> Result<bool, McStoreError> {
        self.context_read(|db| held(db, lease, now_ms))
    }

    /// An expired holder cannot revive itself or extend its successor's lease.
    pub fn renew_dream_domain(
        &self,
        lease: &DreamDomainLease,
        now_ms: i64,
    ) -> Result<bool, McStoreError> {
        self.context_write(&["dream_state"], |tx| {
            if !owns_tx(tx, lease, now_ms)? {
                return Ok(false);
            }
            let expiry = now_ms
                .checked_add(LEASE_DURATION_MS)
                .ok_or(rusqlite::Error::InvalidQuery)?;
            set(tx, &lease.key, "heartbeat", &now_ms.to_string())?;
            set(tx, &lease.key, "expiry", &expiry.to_string())?;
            Ok(true)
        })
    }

    /// Keep the generation row, as the plugin does, to fence later acquisitions.
    /// Compare generation as well as holder so even a reused holder cannot release
    /// an unrelated acquisition after a successor has intervened.
    pub fn release_dream_domain(&self, lease: &DreamDomainLease) -> Result<bool, McStoreError> {
        self.context_write(&["dream_state"], |tx| {
            if get(tx, &lease.key, "holder")?.as_deref() != Some(&lease.holder)
                || generation(tx, &lease.key)? != lease.generation
            {
                return Ok(false);
            }
            for field in ["holder", "heartbeat", "expiry"] {
                tx.execute(
                    "DELETE FROM dream_state WHERE key=?1",
                    [row_key(&lease.key, field)],
                )?;
            }
            Ok(true)
        })
    }
}

#[cfg(test)]
#[path = "dream_domain_tests.rs"]
mod tests;
