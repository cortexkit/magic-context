//! Configuration and project context shared by compaction engines.
use super::*;
use serde::Deserialize;

/// A rendered engine view and its messages in the selected serializer profile.
#[derive(Clone, Serialize, Deserialize)]
pub struct EngineView {
    pub engine: transform::compaction::View,
    pub wire: codec::OutboundMessage,
}

#[derive(Clone)]
pub struct Work {
    binding: SessionBinding,
    pub key: Key,
    project_path: String,
    project_directory: String,
    note_project_path: String,
}

pub fn producer_context<'a>(
    work: &'a Work,
    model: &str,
    window: u64,
    historian_active: bool,
) -> transform::ProducerContext<'a> {
    let config = &work.binding.config;
    let protected = config.resolve_protected_tokens(window);
    let ttl = config.resolve_cache_ttl_with_provenance(Some(model));
    transform::ProducerContext {
        signed_thinking_hold: config.signed_thinking_hold,
        project_path: &work.project_path,
        note_project_path: &work.note_project_path,
        project_directory: &work.project_directory,
        history_budget_tokens: work.binding.history_budget_tokens,
        memory_budget_tokens: config.memory_budget_tokens,
        user_profile_budget_tokens: config.user_profile_budget_tokens,
        memory_enabled: config.memory_enabled,
        inject_docs: config.inject_docs,
        temporal_awareness: config.temporal_awareness,
        now_ms: now_ms(),
        execute_threshold_percentage: config.resolve_execute_threshold(Some(model)).percentage,
        protected_tokens_floor: protected.floor,
        protected_tokens_provenance: if protected.provenance == "derived" {
            "derived"
        } else {
            "absolute"
        },
        compaction_enabled: config.compaction_enabled,
        smart_drops: config.smart_drops,
        protected_tools: config.protected_tools.clone(),
        cache_ttl: ttl.value,
        cache_ttl_provenance: ttl.provenance,
        cache_ttl_policy: None,
        model_key: Some(model.into()),
        observed_last_response_at_ms: None,
        guidance_date: None,
        historian_active,
        wrapup_active: false,
        caveman_english_word_rules: transform::caveman_english_word_rules(
            config.language.as_deref(),
        ),
        #[cfg(test)]
        injected_reductions: vec![],
    }
}

pub fn fold_structure(compartments: &[mc_store::StoredCompartment], through: u64) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for compartment in compartments
        .iter()
        .filter(|compartment| compartment.end_message <= through as i64)
    {
        hash.update(compartment.sequence.to_le_bytes());
        hash.update(compartment.start_message.to_le_bytes());
        hash.update(compartment.end_message.to_le_bytes());
        hash.update((compartment.end_message_id.len() as u64).to_le_bytes());
        hash.update(compartment.end_message_id.as_bytes());
    }
    hash.finalize().into()
}

impl McHandler {
    pub fn provider_work(
        &self,
        channel: u16,
        store: &McStore,
        binding: SessionBinding,
        key: Key,
    ) -> Result<Work, HandlerOutcome> {
        let route = self.route_project(channel, store, &binding)?;
        Ok(Work {
            project_directory: binding.project_root.to_string_lossy().into_owned(),
            note_project_path: route.key.clone(),
            project_path: route.key,
            binding,
            key,
        })
    }
}
