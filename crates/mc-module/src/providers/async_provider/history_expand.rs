//! On-demand history recovery is separate from the compaction read lane.
use super::*;

impl McHandler {
    /// The current lineage's held messages that `wanted` selects (by ordinal and
    /// message id), decoded the same way as the range form, for `ctx_expand` by
    /// tag or message on a runner session. Messages below the lineage's first
    /// ordinal are folded history: only `async_history_expand` reaches them.
    pub(crate) fn async_held_expand(
        &self,
        binding: &SessionBinding,
        namespace: &str,
        wanted: impl Fn(u64, &str) -> bool,
    ) -> Result<Option<Vec<ck_wire::CkIngressMessage>>, HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let rows = super::route_records(store, binding)?;
        let Some(raw) = rows.first() else {
            return Ok(None);
        };
        let header: State = serde_json::from_str(raw).map_err(transient)?;
        if header.namespace() != namespace {
            return Ok(None);
        }
        let Some(state) = load(store, &header.reference())? else {
            return Ok(None);
        };
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
        let mut found = Vec::new();
        for (ordinal, entry) in state.entries.iter() {
            if wanted(*ordinal, &entry.mid) {
                found.push(decoded_entry(codec, &entry.inbound()?)?);
            }
        }
        Ok(Some(found))
    }

    pub(crate) async fn async_history_expand(
        &self,
        binding: &SessionBinding,
        namespace: &str,
        compartments: &[mc_store::StoredCompartment],
        start: i64,
        end: i64,
    ) -> Result<Option<Vec<ck_wire::CkIngressMessage>>, HandlerOutcome> {
        let store = self
            .store
            .get()
            .ok_or_else(|| transient("store unavailable"))?;
        let rows = super::route_records(store, binding)?;
        let Some(raw) = rows.first() else {
            return Ok(None);
        };
        let state: State = serde_json::from_str(raw).map_err(transient)?;
        if state.namespace() != namespace || start >= state.lineage_first_ordinal as i64 {
            return Ok(None);
        }
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone()))?;
        let mut recovered = BTreeMap::new();
        let unknown = || {
            error(
                "unknown_mid",
                "The summary's message id is not available in session.history",
            )
        };
        for compartment in compartments {
            let mid = |id: &str| {
                ck_wire::split_block_id(id)
                    .map_or(id, |(mid, _)| mid)
                    .to_owned()
            };
            let first = mid(&compartment.start_message_id);
            let last = mid(&compartment.end_message_id);
            if first.is_empty() || last.is_empty() {
                return Err(unknown());
            }
            let mut params = json!({"from_mid":first,"max_bytes":1_048_576});
            let mut ordinal = compartment.start_message.max(0) as u64;
            let mut cursors = BTreeSet::new();
            loop {
                let raw = self
                    .provider_runner
                    .call_for_identity(
                        &state.runner()?,
                        &state.runner_identity(),
                        "session.history",
                        params,
                        Duration::from_secs(10),
                    )
                    .await
                    .map_err(|failure| match failure {
                        SessionResolveError::Refused { code, message } if code == "unknown_mid" => {
                            error(&code, &message)
                        }
                        other => runner_error(other),
                    })?;
                let page: cortexkit_role_llm_runner::history::HistoryPage = decode(&raw)?;
                let mut finished = false;
                for entry in page.messages {
                    let at = ordinal;
                    ordinal = ordinal.checked_add(1).ok_or_else(unknown)?;
                    if at as i64 >= start && at as i64 <= end {
                        let inbound = InboundMessage {
                            ordinal: at,
                            mid: entry.mid.clone(),
                            message: entry.message,
                        };
                        recovered.insert(at, decoded_entry(codec, &inbound)?);
                    }
                    if entry.mid == last {
                        finished = true;
                        break;
                    }
                    if at > compartment.end_message.max(0) as u64 {
                        return Err(unknown());
                    }
                }
                if finished {
                    break;
                }
                let Some(next) = page.newer.filter(|next| cursors.insert(next.clone())) else {
                    return Err(unknown());
                };
                params = json!({"cursor":next,"max_bytes":1_048_576});
            }
        }
        Ok(Some(recovered.into_values().collect()))
    }
}
