//! A store sample for the daemon's memory-only health hook.

use std::sync::{Mutex, PoisonError};

use tokio::time::Instant;

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
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT (SELECT COUNT(*) FROM replica_outbox
                              WHERE state IN ('pending', 'sending', 'too_large', 'unaddressable')),
                            held_epoch, held_since FROM replica_state WHERE id = 1",
                    [],
                    |row| {
                        Ok(Store {
                            unsent_count: row.get(0)?,
                            hold: match row.get(1)? {
                                Some(epoch) => Some((epoch, row.get(2)?)),
                                None => None,
                            },
                        })
                    },
                )
            })
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
