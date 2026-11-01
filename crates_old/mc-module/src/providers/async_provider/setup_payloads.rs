//! Cold Setup and move payloads share the provider record's atomic save, but
//! unchanged notices neither serialize them nor load them for header checks.
use super::*;

impl AsyncRecord {
    /// Return only changed payloads and update their small durable references
    /// before serializing the header. The caller commits both in one save.
    pub(super) fn setup_payload_writes(
        &mut self,
    ) -> Result<Vec<(&'static str, String)>, HandlerOutcome> {
        let mut writes = Vec::new();
        // Import staging can clear a ready answer. Once the null is stored,
        // repeated staging saves leave that slot alone as well.
        let cleared = self.initial_ready && self.initial.is_null();
        if !self.initial_stored || cleared {
            let json = serde_json::to_string(&self.initial).map_err(transient)?;
            self.initial_ready =
                self.initial.get("answer").and_then(Value::as_str) == Some("ready");
            self.setup_payload_bytes.0 = json.len();
            self.initial_stored = true;
            writes.push(("setup-initial", json));
        }
        if let Some(moved) = self
            .standalone_move
            .as_mut()
            .filter(|moved| !moved.bound_drops_stored && !moved.bound_drops.is_empty())
        {
            let json = serde_json::to_string(&moved.bound_drops).map_err(transient)?;
            self.setup_payload_bytes.1 = json.len();
            moved.bound_drops_stored = true;
            writes.push(("moved-bound-drops", json));
        }
        Ok(writes)
    }

    /// Header-only reads deliberately leave cold payloads unloaded. Setup
    /// hydrates them explicitly; full loads use their reader snapshot instead.
    pub(super) fn load_setup_payloads(&mut self, store: &McStore) -> Result<(), HandlerOutcome> {
        let reference = self.reference();
        self.restore_setup_payloads(|slot| {
            store
                .load_async_compaction_baseline(&reference, slot)
                .map_err(transient)
        })
    }

    pub(super) fn restore_setup_payloads(
        &mut self,
        mut read: impl FnMut(&str) -> Result<Option<String>, HandlerOutcome>,
    ) -> Result<(), HandlerOutcome> {
        if self.initial_stored {
            let json = read("setup-initial")?
                .ok_or_else(|| transient("async Setup answer row missing"))?;
            self.setup_payload_bytes.0 = json.len();
            self.initial = serde_json::from_str(&json).map_err(transient)?;
        }
        if let Some(moved) = self
            .standalone_move
            .as_mut()
            .filter(|moved| moved.bound_drops_stored)
        {
            let json = read("moved-bound-drops")?
                .ok_or_else(|| transient("async moved drop bindings row missing"))?;
            self.setup_payload_bytes.1 = json.len();
            moved.bound_drops = serde_json::from_str(&json).map_err(transient)?;
        }
        Ok(())
    }
}
