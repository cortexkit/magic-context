//! Policy aggregates and bounded derived fold state share one session lease.
//! Hooks update policy totals; folds additionally reuse the live tail and view.
use super::*;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct ResidentPolicy {
    pub fold_prefix: Option<crate::providers::fold_prefix::FoldPrefix>,
    pub fold_lineage: Option<String>,
    pub fold_structure: Option<[u8; 32]>,
    pub fold_source_raced: bool,
    pub(in crate::providers) fold_arena: crate::providers::resident_bytes::ByteArena,
    pub(crate) fold_hygiene:
        std::sync::Arc<std::sync::Mutex<crate::providers::hygiene_memo::HygieneMemo>>,
    pub fold_data_version: Option<u64>,
    pub(in crate::providers) fold_working: Option<crate::providers::fold_working::FoldWorking>,
    pub(crate) fold_output: Arc<Mutex<transform::SerializedOutputCache>>,
    #[cfg(test)]
    pub fold_tail_passes: u64,
    summary: Option<PolicySummary>,
    saved: Option<String>,
    before: HashMap<String, Option<ProviderPolicyPart>>,
    #[cfg(test)]
    pub rebuilt_parts: usize,
    #[cfg(test)]
    pub replays: u64,
}

impl ResidentPolicy {
    pub fn rebuild(
        index: &ProviderPolicyIndex<'_>,
        counters: &Value,
        floor: u64,
        tools: &BTreeMap<String, usize>,
    ) -> Result<Self, ProviderError> {
        let settings = Settings::resolve(
            &counters["engine_policy"],
            floor,
            tools,
            false,
            counters
                .pointer("/pass_context/model_key")
                .and_then(Value::as_str),
        );
        let parts = index.all_parts()?;
        let saved = index.summary()?;
        let changes = index.changes(CHANGE_CAP)?;
        // The durable change log starts at the last saved summary. Rebuilding
        // already includes those changes, so admitting the next message must
        // subtract the rebuilt rows' contributions, not the older logged copies.
        let before = changes
            .as_ref()
            .map(|changes| {
                changes
                    .iter()
                    .map(|change| (change.block_id.clone(), change.current.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let summary = if saved.is_some() && changes.is_some() {
            build(&parts, &settings, settings.key(index), None)
        } else {
            None
        };
        Ok(Self {
            fold_prefix: crate::providers::fold_prefix::FoldPrefix::build(
                &parts,
                &counters["engine_policy"],
            ),
            fold_lineage: None,
            fold_structure: None,
            fold_source_raced: false,
            fold_arena: Default::default(),
            fold_hygiene: Default::default(),
            fold_data_version: None,
            fold_working: None,
            fold_output: Arc::new(Mutex::new(transform::SerializedOutputCache::new(
                16 * 1024 * 1024,
            ))),
            #[cfg(test)]
            fold_tail_passes: 0,
            summary,
            saved,
            before,
            #[cfg(test)]
            rebuilt_parts: parts.len(),
            #[cfg(test)]
            replays: 0,
        })
    }

    pub fn retained_bytes(&self) -> usize {
        // Charge serialized payload and container overhead conservatively.
        // read_provider_resident_policy bounds input to 100,000 rows / 128 MiB
        // before allocating the temporary rebuild input.
        std::mem::size_of::<Self>()
            + crate::retained_size::ARC_ALLOCATION_OVERHEAD_BYTES
            + std::mem::size_of::<Mutex<transform::SerializedOutputCache>>()
            + self
                .fold_output
                .lock()
                .expect("fold output cache")
                .resident_retained_bytes()
            - std::mem::size_of::<transform::SerializedOutputCache>()
            + self.fold_lineage.as_ref().map_or(0, String::capacity)
            + self.fold_arena.retained_bytes()
            - std::mem::size_of::<crate::providers::resident_bytes::ByteArena>()
            + crate::retained_size::ARC_ALLOCATION_OVERHEAD_BYTES
            + std::mem::size_of::<std::sync::Mutex<crate::providers::hygiene_memo::HygieneMemo>>()
            + self
                .fold_hygiene
                .lock()
                .expect("fold hygiene memo")
                .retained_bytes()
            - std::mem::size_of::<crate::providers::hygiene_memo::HygieneMemo>()
            + self.fold_working.as_ref().map_or(0, |working| {
                working.retained_bytes()
                    - std::mem::size_of::<crate::providers::fold_working::FoldWorking>()
            })
            + self.saved.as_ref().map_or(0, String::capacity)
            + self.summary.as_ref().map_or(0, |summary| {
                serde_json::to_vec(summary).expect("summary JSON").len() * 4
            })
            + self
                .before
                .iter()
                .map(|(key, part)| {
                    key.capacity()
                        + std::mem::size_of::<ProviderPolicyPart>()
                        + part.as_ref().map_or(0, |part| {
                            serde_json::to_vec(part).expect("part JSON").len() * 4
                        })
                })
                .sum::<usize>()
    }

    fn adopt(&mut self, raw: &Option<String>) {
        self.summary = raw.as_ref().and_then(|raw| serde_json::from_str(raw).ok());
        self.saved.clone_from(raw);
        self.before.clear();
    }
}

#[cfg(test)]
#[path = "resident_policy_tests.rs"]
mod tests;

#[allow(clippy::too_many_arguments)]
pub fn resident_channel1_inputs(
    resident: &mut ResidentPolicy,
    index: &ProviderPolicyIndex<'_>,
    engine_policy: &Value,
    floor: u64,
    tools: &BTreeMap<String, usize>,
    carrier: bool,
    cache_busting: bool,
    model_key: Option<&str>,
) -> Result<(Channel1PolicyInputs, Option<String>), ProviderError> {
    let settings = Settings::resolve(engine_policy, floor, tools, cache_busting, model_key);
    let origin_matches = resident.saved == index.summary()?;
    if !cache_busting && index.preparation().is_none() && origin_matches {
        if let Some(held) = resident
            .summary
            .take()
            .filter(|summary| summary.key == settings.key(index))
        {
            if let Some(next) =
                replay_measured(index, held, &settings, None, Some(&resident.before))?
            {
                if let Some(inputs) = inputs_from_summary(&next, &settings, carrier) {
                    #[cfg(test)]
                    check_against_full(
                        index,
                        engine_policy,
                        floor,
                        tools,
                        model_key,
                        &settings,
                        &inputs,
                        &next,
                    )?;
                    let raw = Some(serde_json::to_string(&next).expect("summary JSON"));
                    resident.summary = Some(next);
                    #[cfg(test)]
                    {
                        resident.replays += 1;
                    }
                    resident.saved.clone_from(&raw);
                    resident.before.clear();
                    return Ok((inputs, raw));
                }
            }
        }
    }
    // Compaction, lineage changes and resetting frozen hygiene measurements may
    // invalidate these aggregates. Evaluate the complete policy in that case.
    let result = channel1_inputs(
        index,
        engine_policy,
        floor,
        tools,
        carrier,
        cache_busting,
        model_key,
    )?;
    resident.adopt(&result.1);
    Ok(result)
}
