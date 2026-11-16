//! Only identities are process-wide; checkpoint payloads belong to a session's working set.
use super::*;
use std::time::{Duration, Instant};

pub(super) const SWEEP_EVERY: Duration = Duration::from_secs(15);
const KEEP_FOR: Duration = Duration::from_secs(60);
const IDLE_LIMIT: usize = 8;

#[derive(Default)]
pub(super) struct Cache {
    pub checkpoints: HashSet<SessionRef>,
    pub active: HashSet<SessionRef>,
    pub used: HashMap<SessionRef, Instant>,
    pub pending: HashMap<SessionRef, Vec<Update>>,
    #[cfg(test)]
    pub loads: usize,
    #[cfg(test)]
    pub load_gate: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
}

impl Replica {
    pub(super) fn load(&mut self) {
        let Some(conn) = &self.store else { return };
        let keys = |table: &str| -> rusqlite::Result<HashSet<SessionRef>> {
            conn.prepare(&format!("SELECT runner,harness,session FROM {table}"))?
                .query_map([], |row| {
                    Ok(SessionRef::new(
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect()
        };
        match keys("sessions") {
            Ok(keys) => self.known = keys,
            Err(error) => {
                self.load_failed = true;
                tracing::warn!("ck-mc: app session lookup: {error}");
            }
        }
        match keys("app_read_headers") {
            Ok(keys) => self.cache.checkpoints = keys,
            Err(error) => {
                self.load_failed = true;
                tracing::warn!("ck-mc: app replica load: {error}");
            }
        }
        self.load_projects();
    }

    pub(super) fn activate(&mut self, key: &SessionRef) {
        // A live worker may have uncheckpointed deltas. Keep its projection
        // until the worker is explicitly discarded or releases it, not merely
        // until a timer expires.
        self.cache.active.insert(key.clone());
        let _ = self.ensure_loaded(key);
    }

    /// The session's worker saved its projection to the store and stopped
    /// (a quiet session the module freed). The snapshot then goes like that
    /// of any session no worker holds: once no read used it for
    /// [`KEEP_FOR`], or sooner past [`IDLE_LIMIT`] such sessions. The next
    /// read, or the next worker's first update, loads it from the store
    /// again. A worker that starts again activates it first, and its
    /// activation reaches this thread after the release.
    pub(super) fn release(&mut self, key: &SessionRef) {
        self.cache.active.remove(key);
        self.evict_idle(Instant::now());
    }

    pub(super) fn ensure_loaded(&mut self, key: &SessionRef) -> Result<(), Refusal> {
        let now = Instant::now();
        if !self.cache.used.contains_key(key) && !self.snapshots.contains_key(key) {
            if let Some(conn) = &self.store {
                #[cfg(test)]
                if let Some((started, resume)) = self.cache.load_gate.take() {
                    started.send(()).unwrap();
                    resume.recv().unwrap();
                }
                let snapshot = persistence::load_session(conn, key).map_err(|_| {
                    error(
                        "store_unavailable",
                        "The session read projection is not ready.",
                    )
                })?;
                #[cfg(test)]
                {
                    self.cache.loads += 1;
                }
                if let Some(snapshot) = snapshot {
                    // Hydration is not a change: do not advance watch cursors.
                    let mut snapshot = snapshot;
                    self.enrich(&mut snapshot);
                    self.upgrade_breakdown(&mut snapshot);
                    self.boundaries
                        .insert(key.clone(), boundary_index(&snapshot));
                    self.snapshots.insert(key.clone(), snapshot);
                }
            }
        }
        self.cache.used.insert(key.clone(), now);
        if let Some(updates) = self.cache.pending.remove(key) {
            for update in updates {
                self.apply_update(update);
            }
        }
        self.evict_idle(now);
        Ok(())
    }

    pub(super) fn evict_idle(&mut self, now: Instant) {
        if self.store.is_none() {
            return;
        }
        let mut idle: Vec<_> = self
            .cache
            .used
            .iter()
            .filter(|(key, _)| !self.cache.active.contains(*key))
            .map(|(key, used)| (key.clone(), *used))
            .collect();
        idle.sort_by_key(|(_, used)| *used);
        let excess = idle.len().saturating_sub(IDLE_LIMIT);
        for (i, (key, used)) in idle.into_iter().enumerate() {
            if i < excess || now.duration_since(used) >= KEEP_FOR {
                self.snapshots.remove(&key);
                self.boundaries.remove(&key);
                self.cache.used.remove(&key);
                self.forget_head(&key);
            }
        }
    }
}

#[cfg(test)]
mod release_tests {
    use super::*;

    /// A session whose worker freed it keeps its snapshot only while reads
    /// use it, then answers from its saved checkpoint as before.
    #[test]
    fn app_read_a_released_session_is_evicted_and_read_again_from_its_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
        let snapshot = super::super::tests::fixture();
        super::super::tests::save_fixture(&store, &snapshot, None);
        let key = snapshot.key.clone();
        let mut replica = super::super::tests::replica(None);
        replica.snapshots.clear();
        replica.store = Some(
            Connection::open_with_flags(&store.path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap(),
        );
        replica.load();
        replica.activate(&key);
        let params = json!({"session":key,"message_ids":["m1","m2"]});
        let mut before = replica.read("context.states", &params).unwrap();
        let later = Instant::now() + KEEP_FOR + Duration::from_secs(1);
        replica.evict_idle(later);
        assert!(replica.snapshots.contains_key(&key), "a live worker's");
        // Just used, a released snapshot stays for the reads using it.
        replica.release(&key);
        assert!(replica.snapshots.contains_key(&key));
        replica.evict_idle(later);
        assert!(!replica.snapshots.contains_key(&key), "released, then idle");
        let mut after = replica.read("context.states", &params).unwrap();
        assert!(replica.snapshots.contains_key(&key), "read again");
        for read in [&mut before, &mut after] {
            read.as_object_mut().unwrap().remove("as_of_ms");
        }
        assert_eq!(before, after);
    }
}
