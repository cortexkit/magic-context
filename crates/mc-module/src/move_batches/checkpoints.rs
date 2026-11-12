//! Move-owned PASSIVE checkpoints between transactions, paced by observed WAL
//! frames rather than elapsed COMMIT time or the WAL file's allocated length.

use rusqlite::Connection;

#[cfg(test)]
#[path = "checkpoint_tests.rs"]
mod tests;

pub(super) const TARGET_PAGES: i64 = 16_000;
pub(crate) const WRITE_WINDOW: std::time::Duration = std::time::Duration::from_millis(18);

// Tests fix the grouping clock; production uses the measured lock hold time.
#[cfg(not(test))]
fn grouping_duration(held: std::time::Duration) -> std::time::Duration {
    held
}

#[cfg(test)]
fn grouping_duration(held: std::time::Duration) -> std::time::Duration {
    crate::move_in::tests::writer::grouping_duration(held)
}

// Tests can seed the cap without adaptive warmup; production starts at one unit.
#[cfg(not(test))]
fn initial_units() -> usize {
    1
}

#[cfg(test)]
fn initial_units() -> usize {
    crate::move_in::tests::writer::initial_units()
}

#[cfg(test)]
#[test]
fn move_in_adaptive_limit_cannot_grow_past_4096_units() {
    let _clock = crate::move_in::tests::writer::fixed_clock(
        crate::move_in::tests::writer::Clock::Continue,
        4096,
    );
    let mut conn = Connection::open_in_memory().unwrap();
    let mut writer = Writer::new(&mut conn).unwrap();
    // Even an arbitrarily cheap 4096-unit group must not double the hard cap.
    writer.grouped("cap", |_| Ok(4096)).unwrap();
    assert_eq!(writer.limit("cap"), 4096);
    writer.finish().unwrap();
}

pub(super) struct Writer<'a> {
    conn: &'a mut Connection,
    previous: i64,
    target: i64,
    phase: String,
    interval: usize,
    batches: usize,
    log: i64,
    copied: i64,
    finished: bool,
    units: usize,
}

impl<'a> Writer<'a> {
    pub(super) fn new(conn: &'a mut Connection) -> Result<Self, String> {
        let previous = conn
            .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        // This connection takes responsibility for checkpointing its writes;
        // the policy is restored once the bulk stage/application ends.
        conn.pragma_update(None, "wal_autocheckpoint", 0)
            .map_err(|e| e.to_string())?;
        let target = TARGET_PAGES;
        #[cfg(test)]
        let target = crate::move_in::tests::checkpoint_target(target);
        Ok(Self {
            conn,
            previous,
            target,
            phase: String::new(),
            interval: 1,
            batches: 0,
            log: 0,
            copied: 0,
            finished: false,
            units: initial_units(),
        })
    }

    pub(super) fn transaction<T>(
        &mut self,
        phase: &str,
        write: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        self.perform(phase, write).map(|(value, _)| value)
    }

    pub(super) fn limit(&self, phase: &str) -> usize {
        if phase == self.phase {
            self.units
        } else {
            initial_units()
        }
    }

    pub(super) fn grouped(
        &mut self,
        phase: &str,
        write: impl FnOnce(&Connection) -> Result<usize, String>,
    ) -> Result<usize, String> {
        let (count, held) = self.perform(phase, write)?;
        // One plan unit contains at most 32 row writes. Commits combine units
        // as their measured cost permits. Keep reads/decoding outside the write
        // lock and cap prefetched units independently of the elapsed-time stop.
        // Aim for 20 ms including COMMIT; the write loop stops at 18 ms to
        // leave room for the final progress update and commit bookkeeping.
        let proposed = (count as u128 * 20_000_000 / grouping_duration(held).as_nanos().max(1))
            .max(1) as usize;
        self.units = proposed.min(count.saturating_mul(2)).clamp(1, 4096);
        Ok(count)
    }

    fn perform<T>(
        &mut self,
        phase: &str,
        write: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<(T, std::time::Duration), String> {
        if self.phase != phase {
            if self.batches > 0 {
                self.checkpoint()?;
            }
            self.phase = phase.into();
            // A different table can dirty many more pages per batch. Sample
            // its first commit before extrapolating an interval from it.
            self.interval = 1;
        }
        let (result, held) = super::transaction_measured(self.conn, phase, write)?;
        self.batches += 1;
        if self.batches >= self.interval {
            self.checkpoint()?;
        }
        // SQLite's ordinary busy handler backs off between retries. Yield a
        // lock-free window at least as long as the write, so another host is
        // not starved by immediate reacquisition of many short transactions.
        std::thread::sleep(held.max(std::time::Duration::from_millis(5)));
        Ok((result, held))
    }

    fn checkpoint(&mut self) -> Result<(), String> {
        assert!(
            self.conn.is_autocommit(),
            "checkpoint must run outside a transaction"
        );
        #[cfg(test)]
        let started = std::time::Instant::now();
        let (busy, log, copied): (i64, i64, i64) = self
            .conn
            .query_row("PRAGMA main.wal_checkpoint(PASSIVE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| format!("move_checkpoint_failed: {e}"))?;
        // A smaller log indicates a WAL restart. Other connections may have
        // checkpointed in the meantime; this is deliberately an estimate, not
        // a claim that every observed frame was written by this mover.
        let frames = estimated_frames(log, self.log, self.copied);
        #[cfg(test)]
        crate::move_in::tests::checkpoint_sample(
            &self.phase,
            started.elapsed(),
            frames,
            log,
            copied,
            busy,
        );
        if busy == 0 && log >= 0 && copied >= 0 {
            let proposed = if frames == 0 {
                self.interval.saturating_mul(2)
            } else {
                ((self.batches.max(1) as i64 * self.target) / frames).max(1) as usize
            };
            self.interval = proposed
                .clamp(self.interval.div_ceil(2), self.interval.saturating_mul(2))
                .clamp(1, 4096);
            self.log = log;
            self.copied = copied;
        }
        self.batches = 0;
        Ok(())
    }

    pub(super) fn finish(&mut self) -> Result<(), String> {
        self.checkpoint()?;
        self.finished = true;
        Ok(())
    }
}

fn estimated_frames(log: i64, previous_log: i64, previous_copied: i64) -> i64 {
    if log < previous_log {
        log
    } else {
        log - previous_copied
    }
    .max(0)
}

impl std::ops::Deref for Writer<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.conn
    }
}

impl Drop for Writer<'_> {
    fn drop(&mut self) {
        // Errors and simulated exits still release checkpoint ownership before
        // restoring automatic checkpoints; committed progress remains resumable.
        if !self.finished {
            if let Err(error) = self.checkpoint() {
                tracing::warn!("ck-mc: {error}");
            }
        }
        if let Err(error) = self
            .conn
            .pragma_update(None, "wal_autocheckpoint", self.previous)
        {
            tracing::warn!("ck-mc: restoring move checkpoint policy: {error}");
        }
    }
}
