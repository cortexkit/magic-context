//! Incremental content proof for the held input omitted by a logical prefix.
use super::*;
use std::ops::Deref;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct InputProof {
    before: u64,
    count: usize,
    digest: [u8; 32],
}

/// Mutations update the proof as well as the map. There is deliberately no
/// mutable dereference: replacing a covered entry must invalidate its certificate.
#[derive(Default)]
pub(super) struct HeldEntries {
    entries: BTreeMap<u64, Arc<HeldEntry>>,
    proof: InputProof,
    mutation_epoch: u64,
}

impl Deref for HeldEntries {
    type Target = BTreeMap<u64, Arc<HeldEntry>>;
    fn deref(&self) -> &Self::Target {
        &self.entries
    }
}

impl<'a> IntoIterator for &'a HeldEntries {
    type Item = (&'a u64, &'a Arc<HeldEntry>);
    type IntoIter = std::collections::btree_map::Iter<'a, u64, Arc<HeldEntry>>;
    fn into_iter(self) -> Self::IntoIter {
        self.entries.iter()
    }
}

impl InputProof {
    fn toggle(&mut self, ordinal: u64, entry: &HeldEntry) {
        // Include the map key as well as the source digest, so moving entries
        // between ordinals cannot preserve this order-sensitive multiset proof.
        let mut hash = Sha256::new();
        hash.update(ordinal.to_le_bytes());
        hash.update(entry.input_digest);
        for (accumulator, byte) in self.digest.iter_mut().zip(hash.finalize()) {
            *accumulator ^= byte;
        }
    }
}

impl HeldEntries {
    pub(super) fn insert(&mut self, ordinal: u64, entry: Arc<HeldEntry>) -> Option<Arc<HeldEntry>> {
        if self
            .entries
            .last_key_value()
            .is_some_and(|(last, _)| ordinal <= *last)
        {
            self.mutation_epoch = self.mutation_epoch.wrapping_add(1);
        }
        let old = self.entries.insert(ordinal, entry.clone());
        if ordinal < self.proof.before {
            if let Some(old) = &old {
                self.proof.toggle(ordinal, old);
            } else {
                self.proof.count += 1;
            }
            self.proof.toggle(ordinal, &entry);
        }
        old
    }

    pub(super) fn remove(&mut self, ordinal: &u64) -> Option<Arc<HeldEntry>> {
        let old = self.entries.remove(ordinal)?;
        self.mutation_epoch = self.mutation_epoch.wrapping_add(1);
        if *ordinal < self.proof.before {
            self.proof.toggle(*ordinal, &old);
            self.proof.count -= 1;
        }
        Some(old)
    }

    pub(super) fn retain(&mut self, mut keep: impl FnMut(&u64, &Arc<HeldEntry>) -> bool) {
        let removed = self
            .entries
            .iter()
            .filter_map(|(n, e)| (!keep(n, e)).then_some(*n))
            .collect::<Vec<_>>();
        for ordinal in removed {
            self.remove(&ordinal);
        }
    }

    pub(super) fn clear(&mut self) {
        self.mutation_epoch = self.mutation_epoch.wrapping_add(1);
        self.entries.clear();
        self.proof.count = 0;
        self.proof.digest = [0; 32];
    }

    /// Append-only preparation may reuse a prefix only while this epoch agrees.
    pub(super) fn mutation_epoch(&self) -> u64 {
        self.mutation_epoch
    }

    /// Move the certified cut using only the entries crossed by that move. A
    /// repeated request for the same cut does no covered-entry work, even after appends.
    pub(super) fn proof_before(&mut self, before: u64) -> InputProof {
        let old = self.proof.before;
        if before >= old {
            for (ordinal, entry) in self.entries.range(old..before) {
                self.proof.toggle(*ordinal, entry);
                self.proof.count += 1;
            }
        } else {
            for (ordinal, entry) in self.entries.range(before..old) {
                self.proof.toggle(*ordinal, entry);
                self.proof.count -= 1;
            }
        }
        self.proof.before = before;
        self.proof.clone()
    }

    #[cfg(test)]
    pub(super) fn proof_before_peek(&self) -> InputProof {
        self.proof.clone()
    }

    pub(super) fn matches(&self, expected: Option<&InputProof>, before: u64) -> bool {
        expected.is_some_and(|expected| expected.before == before && expected == &self.proof)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(ordinal: u64, text: &str) -> Arc<HeldEntry> {
        Arc::new(
            HeldEntry::from_read(&ReadMessage::new(
                ordinal,
                format!("m{ordinal}"),
                json!({"content":text}),
            ))
            .unwrap(),
        )
    }

    #[test]
    fn content_proof_tracks_replacement_deletion_reorder_and_reloaded_entries() {
        let mut entries = HeldEntries::default();
        for n in 0..8 {
            entries.insert(n, entry(n, "original"));
        }
        let proof = entries.proof_before(6);
        entries.insert(8, entry(8, "appended"));
        assert!(entries.matches(Some(&proof), 6));
        let original = entries.insert(2, entry(2, "edited")).unwrap();
        assert!(!entries.matches(Some(&proof), 6));
        entries.insert(2, original);
        assert!(entries.matches(Some(&proof), 6));
        let deleted = entries.remove(&3).unwrap();
        assert!(!entries.matches(Some(&proof), 6));
        entries.insert(3, deleted);
        let left = entries[&1].clone();
        let right = entries[&2].clone();
        entries.insert(1, right.clone());
        entries.insert(2, left.clone());
        assert!(!entries.matches(Some(&proof), 6));
        entries.insert(1, left);
        entries.insert(2, right);
        assert!(entries.matches(Some(&proof), 6));
        let mut reloaded = HeldEntries::default();
        for (n, entry) in &entries {
            reloaded.insert(
                *n,
                Arc::new(HeldEntry::from_stored(entry.raw().to_owned()).unwrap()),
            );
        }
        assert!(reloaded.proof_before(6) == proof);
        let mut damaged = serde_json::from_str::<ReadMessage>(entries[&4].raw()).unwrap();
        damaged.message["content"] = json!("stored corruption");
        reloaded.insert(4, Arc::new(HeldEntry::from_read(&damaged).unwrap()));
        assert!(!reloaded.matches(Some(&proof), 6));
        assert!(entries.proof_before(8) != proof);
        assert!(entries.proof_before(6) == proof);
    }

    #[test]
    #[ignore = "incremental content-proof cost at 50k and 150k held messages"]
    fn content_proof_cost_benchmark() {
        for size in [50_000, 150_000] {
            let mut entries = HeldEntries::default();
            for n in 0..size {
                entries.insert(n, entry(n, "source bytes"));
            }
            let start = Instant::now();
            let proof = entries.proof_before(size - 3000);
            let initial = start.elapsed();
            let start = Instant::now();
            for _ in 0..100_000 {
                assert!(std::hint::black_box(&entries).matches(Some(&proof), size - 3000));
                assert!(entries.proof_before(size - 3000) == proof);
            }
            eprintln!("content proof size={size}: initial crossed_entries={} {:?}; repeated checks=100000 {:?}; repeated covered entries hashed=0", size - 3000, initial, start.elapsed());
        }
    }
}
