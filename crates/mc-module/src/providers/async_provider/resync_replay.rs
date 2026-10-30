//! A resync verifies sources; it does not by itself prove the model lost its cache.
use super::*;

#[derive(Serialize, Deserialize)]
pub(super) struct Replay {
    pub engine: transform::compaction::State,
    pub entries: BTreeMap<u64, String>,
    first_ordinal: u64,
}

impl Replay {
    pub(super) fn capture(state: &State) -> Result<Option<Self>, HandlerOutcome> {
        if state.entries.is_empty() || state.applied_view.is_none() {
            return Ok(None);
        }
        Ok(Some(Self {
            engine: state.engine_with_baselines()?,
            entries: state
                .entries
                .iter()
                .map(|(ordinal, entry)| Ok((*ordinal, fingerprint(&entry.read()?)?)))
                .collect::<Result<_, HandlerOutcome>>()?,
            first_ordinal: state.lineage_first_ordinal,
        }))
    }

    pub(super) fn matches(&self, state: &State) -> Result<bool, HandlerOutcome> {
        if self.first_ordinal != state.lineage_first_ordinal {
            return Ok(false);
        }
        // Appended messages do not invalidate a verified prefix. Every old
        // position must survive unchanged; matching only surviving mids would
        // also accept truncation, reordering, or a changed tag assignment.
        for (ordinal, old) in &self.entries {
            let Some(entry) = state.entries.get(ordinal) else {
                return Ok(false);
            };
            if fingerprint(&entry.read()?)? != *old {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

fn fingerprint(entry: &ReadMessage) -> Result<String, HandlerOutcome> {
    // This is a private equality proof for the same fields as stable_entry,
    // not a content identity computed from descriptor payloads. Content
    // identities remain the runner's digest and part_digests, used as given.
    let bytes = serde_jcs::to_vec(&(
        entry.ordinal,
        &entry.mid,
        &entry.message,
        &entry.digest,
        &entry.part_digests,
        &entry.tags,
        &entry.role,
        &entry.written_at,
        &entry.delivered_as,
    ))
    .map_err(transient)?;
    Ok(crate::sha256_hex(&bytes))
}
