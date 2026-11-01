//! Capture served bytes and stored decisions from randomized signed-thinking passes.
//! scripts/signed-thinking-hold-differential.test.ts compiles this same corpus against
//! master 62f20c02 (without experimental admission) as an independent source oracle
//! for requests with signed_thinking_hold set to off.
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_module::config::CacheTtlProvenance;
use mc_module::transform::{transform, ProducerContext, TransformRequest};
use mc_store::McStore;
use serde_json::{json, Value};

fn context() -> ProducerContext<'static> {
    ProducerContext {
        signed_thinking_hold: mc_module::config::SignedThinkingHold::Off,
        project_path: "git:hold-off-corpus",
        note_project_path: "git:hold-off-corpus",
        project_directory: "/nonexistent-docs",
        history_budget_tokens: 60_000.0,
        memory_budget_tokens: 8_000.0,
        user_profile_budget_tokens: 4_000.0,
        memory_enabled: false,
        inject_docs: false,
        temporal_awareness: false,
        now_ms: 1_000,
        execute_threshold_percentage: 65.0,
        protected_tokens_floor: 4_000,
        protected_tokens_provenance: "config",
        compaction_enabled: true,
        smart_drops: false,
        protected_tools: Default::default(),
        cache_ttl: "5m".into(),
        cache_ttl_provenance: CacheTtlProvenance::Default,
        cache_ttl_policy: None,
        model_key: None,
        observed_last_response_at_ms: None,
        guidance_date: None,
        historian_active: false,
        wrapup_active: false,
        caveman_english_word_rules: true,
    }
}

fn message(mid: &str, ordinal: u64, role: &str, kinds: Vec<Value>) -> Value {
    json!({"mid":mid,"ordinal":ordinal,"ck":{"role":role,
        "content":kinds.into_iter().map(|kind| json!({"kind":kind})).collect::<Vec<_>>(),
        "meta":{"harness_id":mid}}})
}

#[test]
fn signed_thinking_hold_off_randomized_pass_corpus() {
    let root = std::env::temp_dir().join("magic-context/signed-thinking-hold-off-corpus");
    std::fs::create_dir_all(&root).unwrap();
    let mut random_state = 630665_u32;
    let mut random = |n| {
        random_state ^= random_state << 13;
        random_state ^= random_state >> 17;
        random_state ^= random_state << 5;
        random_state % n
    };
    let mut captures = Vec::new();
    for profile in ["opencode-aisdk", "claude-code-anthropic", "owned-broca"] {
        for seed in 0..12 {
            let dir = tempfile::tempdir_in(&root).unwrap();
            let store = McStore::open_for_test(&StorageDescriptor {
                module_id: "hold-off-corpus".into(),
                storage_namespace: "mc_cache".into(),
                isolation: Isolation::Module,
                backend: StorageBackend::Sqlite {
                    path: dir.path().join("store.db").to_string_lossy().into(),
                },
            })
            .unwrap();
            let subagent = seed % 3 == 0;
            let mut request: TransformRequest = serde_json::from_value(json!({
                "v":2,"serializer_profile":profile,"session_id":"corpus","render_config":"stable",
                "provider_id":"anthropic","model_key":if seed % 4 == 0 { "anthropic/claude-sonnet-4-6" } else { "anthropic/claude-opus-5-5" },
                "is_subagent":subagent,"tool_present":true,"todo_tool_present":false,
                "auto_search_enabled":false,"keep_reasoning_tokens_effective":1_000_000,
                "protected_tokens_effective":4000,"caveman_enabled":true,"caveman_min_chars":40,
                "usage":{"current_total_input_tokens":20000,"context_limit_tokens":100000},"messages":[]
            })).unwrap();
            let ctx = context();
            let mut ordinal = 0;
            for turn in 0..14 {
                let new_user = turn == 0 || (!subagent && turn % 5 == 0);
                ordinal += 1;
                let mid = format!("message-{turn}");
                let mut kinds = vec![
                    json!({"type":"text","text":"The parser should return the current token and then advance to the next token. ".repeat(160)}),
                ];
                if !new_user {
                    if seed % 4 != 0 && random(3) != 0 {
                        kinds.insert(0, json!({"type":"reasoning","text":format!("Reasoning {turn}"),"signature":format!("signed-{seed}-{turn}")}));
                    }
                    kinds.push(json!({"type":"tool_call","id":format!("read-{turn}"),"name":"read","input":{"path":format!("/project/file-{}.ts",random(3))},"provider_executed":false}));
                }
                request.messages.push(
                    serde_json::from_value(message(
                        &mid,
                        ordinal,
                        if new_user { "user" } else { "assistant" },
                        kinds,
                    ))
                    .unwrap(),
                );
                if !new_user {
                    ordinal += 1;
                    request.messages.push(serde_json::from_value(message(&format!("result-{turn}"), ordinal, "tool", vec![json!({"type":"tool_result","id":format!("read-{turn}"),"tool_name":"read","output":{"kind":{"type":"text","text":"export function parse(tokens) {}\n".repeat(150)}},"provider_executed":false})])).unwrap());
                }
                let percentage = [20, 66, 86, 96][random(4) as usize];
                request.usage.as_mut().unwrap().current_total_input_tokens = percentage * 1000;
                // Initialize before arming a refresh; both old and new stores require a session row.
                if turn > 0 && random(3) == 0 {
                    store.arm_soft_refresh("corpus").unwrap();
                }
                for replay in 0..2 {
                    let response = transform(&store, &request, &ctx).unwrap();
                    let loaded = store.load("corpus").unwrap();
                    let mut meta = serde_json::to_value(&loaded.meta).unwrap();
                    if let Some(fields) = meta.as_object_mut() {
                        assert!(fields.get("held_release").is_none_or(Value::is_null));
                        // The merge-base ModuleMeta lacks these memory-projection fields and
                        // the dormant release column. Their schema additions are not a change
                        // to the flush, force, reduction or reasoning decisions compared here.
                        for key in [
                            "held_release",
                            "memory_projection",
                            "score_selection_watermark",
                        ] {
                            fields.remove(key);
                        }
                    }
                    captures.push(
                        json!({"profile":profile,"seed":seed,"turn":turn,"replay":replay,
                        "served":serde_json::to_string(response.messages()).unwrap(),"meta":meta,
                        "core":serde_json::to_value(&loaded.core).unwrap()}),
                    );
                }
            }
        }
    }
    assert_eq!(captures.len(), 1008);
    if let Some(path) = std::env::var_os("MC_HOLD_RUST_CORPUS_OUTPUT") {
        std::fs::write(path, serde_json::to_vec(&captures).unwrap()).unwrap();
    }
    println!(
        "hold-off Rust corpus: {} passes; 36 sessions; seed=630665",
        captures.len()
    );
}

/// Rust classifies an empty cache as HARD to freeze its first m[0]/m[1] head.
/// TS/Pi have a separate firstRenderBust check that prices cleanup. Compare
/// Rust's actual cold served bytes and cache writes against master instead.
#[test]
fn signed_thinking_hold_off_cold_bootstrap() {
    let root = std::env::temp_dir().join("magic-context/signed-thinking-hold-cold-rust");
    std::fs::create_dir_all(&root).unwrap();
    let mut captures = Vec::new();
    for profile in ["opencode-aisdk", "claude-code-anthropic", "owned-broca"] {
        let dir = tempfile::tempdir_in(&root).unwrap();
        let store = McStore::open_for_test(&StorageDescriptor {
            module_id: "cold-hold-off".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into(),
            },
        })
        .unwrap();
        let before = store.load("cold").unwrap();
        assert!(!before.meta.initialized);
        assert!(!before
            .core
            .frozen_units
            .iter()
            .any(|unit| unit.key == "m0" || unit.key == "m1"));
        let request: TransformRequest = serde_json::from_value(json!({
            "v":2, "serializer_profile":profile, "session_id":"cold", "render_config":"stable",
            "provider_id":"anthropic", "model_key":"anthropic/claude-opus-5-5",
            "tool_present":true, "todo_tool_present":false, "auto_search_enabled":false,
            "keep_reasoning_tokens_effective":1_000_000, "protected_tokens_effective":4000,
            "usage":{"current_total_input_tokens":20000,"context_limit_tokens":100000},
            "messages":[
                message("u",1,"user",vec![json!({"type":"text","text":"Inspect the parser."})]),
                message("signed",2,"assistant",vec![json!({"type":"reasoning","text":"Keep inspecting.","signature":"cold-signed"}),json!({"type":"text","text":"Keep inspecting."})]),
                message("tail",3,"assistant",vec![json!({"type":"text","text":"Continue after the signed boundary."})])
            ]
        })).unwrap();
        let response = transform(&store, &request, &context()).unwrap();
        let after = store.load("cold").unwrap();
        let mut meta = serde_json::to_value(&after.meta).unwrap();
        let fields = meta.as_object_mut().unwrap();
        assert!(fields.get("held_release").is_none_or(Value::is_null));
        for key in [
            "held_release",
            "memory_projection",
            "score_selection_watermark",
        ] {
            fields.remove(key);
        }
        captures.push(
            json!({"profile":profile,"served":serde_json::to_string(response.messages()).unwrap(),
            "meta":meta,"core":serde_json::to_value(after.core).unwrap()}),
        );
    }
    if let Some(path) = std::env::var_os("MC_HOLD_RUST_COLD_OUTPUT") {
        std::fs::write(path, serde_json::to_vec(&captures).unwrap()).unwrap();
    }
    println!("cold Rust signed-thinking: 3 profiles; no prior head, flush, force or history");
}
