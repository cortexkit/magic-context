//! A store sample for the daemon's memory-only health hook.

use std::sync::{Mutex, PoisonError};

use tokio::time::Instant;

use super::OUTBOX_BACKLOG;
use crate::context_db::ContextDb;

/// The replica loop samples the store at its existing wakeups. Only one
/// ck-mc process serves a store, and the older TypeScript plugins refuse to
/// open a store at this schema version, so no other process can change these
/// rows behind the replica loop's back.
pub(crate) struct Health {
    pub(crate) started: Instant,
    sample: Mutex<Option<Sample>>,
}

#[derive(Clone)]
pub(crate) struct Sample {
    pub(crate) at: Instant,
    pub(crate) store: Result<Store, String>,
}

#[derive(Clone, Copy)]
pub(crate) struct Store {
    pub(crate) unsent_count: u64,
    pub(crate) local_only_count: u64,
    pub(crate) reject_count: u64,
    pub(crate) routine_skip_count: u64,
    /// The stream stops at the first message whose fleet key generation
    /// (epoch) is missing locally, so only one epoch can hold it at a time.
    pub(crate) hold: Option<(u64, i64)>,
}

impl Default for Health {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            sample: Mutex::new(None),
        }
    }
}

impl Health {
    /// The loop is the only writer. Never hold the snapshot lock across SQL,
    /// and cap the read rate even during catch-up or repeated local writes.
    pub(super) fn refresh(&self, db: &ContextDb) {
        if self
            .sample
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .is_some_and(|sample| sample.at.elapsed() < super::live::IDLE)
        {
            return;
        }

        let store = db
            .with_connection(read_store)
            .map_err(|error| error.to_string());

        *self.sample.lock().unwrap_or_else(PoisonError::into_inner) = Some(Sample {
            at: Instant::now(),
            store,
        });
    }

    pub(crate) fn read(&self) -> Result<Option<Sample>, &'static str> {
        self.sample
            .try_lock()
            .map(|sample| sample.clone())
            .map_err(|_| "replica health snapshot unavailable")
    }
}

fn read_store(conn: &mut rusqlite::Connection) -> rusqlite::Result<Store> {
    // Older versions recorded these two kinds of harmless skips as refusals.
    // Do not count them as refusals while they age out of the table.
    let mut store = conn.query_row(
        &format!("SELECT (SELECT COUNT(*) FROM replica_outbox WHERE state IN {OUTBOX_BACKLOG}),
                (SELECT COUNT(*) FROM replica_rejects
                  WHERE reason NOT GLOB 'a copy of *, applied here before: a send tried again after the hub''s duplicate window'
                    AND reason NOT GLOB 'a dreamer change written under generation *, older than generation * the stream holds a change of this row under'),
                COALESCE((SELECT CAST(value AS INTEGER) FROM schema_migrations_meta WHERE key = ?1), 0),
                held_epoch, held_since FROM replica_state WHERE id = 1"),
        [super::ROUTINE_SKIPS_KEY],
        |row| Ok(Store {
            unsent_count: row.get(0)?,
            local_only_count: 0,
            reject_count: row.get(1)?,
            routine_skip_count: row.get(2)?,
            hold: match row.get(3)? {
                Some(epoch) => Some((epoch, row.get(4)?)),
                None => None,
            },
        }),
    )?;
    // Unplaced legacy rows kept a project path instead of a project id.
    // Use the publisher's address check, and leave already-frozen changes
    // alone: they have an address fixed independently of the current row.
    let mut stmt = conn.prepare(&format!(
        "SELECT m.owner_id FROM replica_outbox o JOIN memories m ON m.id = o.local_id
          WHERE o.state IN {OUTBOX_BACKLOG} AND o.kind = 'memory' AND o.frozen IS NULL AND m.level = 'project'"
    ))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let owner: String = row.get(0)?;
        if super::wire::subject("memory", Some("project"), &owner).is_err() {
            store.local_only_count += 1;
        }
    }
    store.unsent_count -= store.local_only_count;
    Ok(store)
}
