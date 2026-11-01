//! Offline transform/codec driver for host replay tests; all state lives in the supplied directory.
use std::io::{self, Read};

use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_module::{codec, transform};
use mc_store::McStore;
use serde_json::{json, Value};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = std::env::args()
        .nth(1)
        .ok_or("expected scratch directory")?;
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let body: Value = serde_json::from_str(&input)?;
    let request: transform::TransformRequest = serde_json::from_value(body.clone())?;
    let store = McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context-replay-test".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: format!("{directory}/store.db"),
        },
    })?;
    let context = transform::ProducerContext {
        project_path: "git:replay",
        note_project_path: "git:replay",
        project_directory: &directory,
        history_budget_tokens: 60_000.0,
        memory_budget_tokens: 8_000.0,
        user_profile_budget_tokens: 4_000.0,
        memory_enabled: false,
        inject_docs: false,
        temporal_awareness: false,
        now_ms: 1_000,
        execute_threshold_percentage: 65.0,
        protected_tokens_floor: 16_000,
        protected_tokens_provenance: "derived",
        compaction_enabled: true,
        smart_drops: false,
        signed_thinking_hold: mc_module::config::SignedThinkingHold::Off,
        protected_tools: Default::default(),
        cache_ttl: "5m".into(),
        cache_ttl_provenance: mc_module::config::CacheTtlProvenance::Default,
        cache_ttl_policy: None,
        model_key: None,
        observed_last_response_at_ms: None,
        guidance_date: Some("Today's date: Thu Jan 01 1970".into()),
        historian_active: false,
        wrapup_active: false,
        caveman_english_word_rules: true,
    };
    let result = transform::transform(&store, &request, &context)?;
    let native_input = body["native_messages"]
        .as_array()
        .ok_or("native_messages required")?;
    let decoded = codec::decode_opencode(native_input);
    let messages = result
        .messages()
        .iter()
        .map(|m| (**m).clone())
        .collect::<Vec<_>>();
    let native = codec::encode_opencode_with_session(
        &messages,
        &decoded.sidecar,
        Some(&request.session_id),
        None,
    );
    let mut response = serde_json::to_value(&result)?;
    response["native_messages"] = json!(native);
    response["test_pending_tag_block_ids"] =
        json!(store.load(&request.session_id)?.meta.pending_tag_block_ids);
    response["test_tag_rows"] = json!(store
        .load_tags_for_session(&request.session_id)?
        .iter()
        .map(|row| json!({"block_id": row.block_id, "tag_number": row.tag_number}))
        .collect::<Vec<_>>());
    println!("{response}");
    Ok(())
}
