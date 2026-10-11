//! Opt-in tests for system-text stripping profile scope and protection before signed thinking.
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_module::config::CacheTtlProvenance;
use mc_module::transform::{transform, ProducerContext, TransformRequest};
use mc_store::McStore;
use serde_json::{json, Value};

fn enabled() -> bool {
    std::env::var("MC_S03A_REVIEW").as_deref() == Ok("1")
}

fn context() -> ProducerContext<'static> {
    ProducerContext {
        project_path: "git:s03a-review",
        note_project_path: "git:s03a-review",
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

fn run(profile: &str, signed: bool) -> (Vec<String>, Value) {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&StorageDescriptor {
        module_id: "s03a-review".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into(),
        },
    })
    .unwrap();
    let mut messages = vec![
        message(
            "u",
            1,
            "user",
            vec![json!({"type":"text","text":"inspect parser"})],
        ),
        message(
            "notification",
            2,
            "assistant",
            vec![json!({"type":"text","text":"words <system-reminder>noise</system-reminder>"})],
        ),
    ];
    for n in 0..42 {
        messages.push(message(
            &format!("filler-{n}"),
            n + 3,
            "assistant",
            vec![json!({"type":"text","text":format!("note {n}")})],
        ));
    }
    if signed {
        messages.push(message(
            "signed",
            45,
            "assistant",
            vec![
                json!({"type":"reasoning","text":"kept","signature":"signed"}),
                json!({"type":"text","text":"continue"}),
            ],
        ));
    }
    let req: TransformRequest = serde_json::from_value(json!({
        "serializer_profile":profile,"session_id":"s03a-review","render_config":"stable",
        "provider_id":"anthropic","model_key":"anthropic/claude-opus-5-5",
        "is_subagent":false,"tool_present":true,"auto_search_enabled":false,
        "clear_reasoning_age":1000,"keep_reasoning_tokens_effective":1_000_000,
        "protected_tokens_effective":4000,"protected_tags":0,"protected_tags_present":true,
        "usage":{"current_total_input_tokens":95_000,"context_limit_tokens":100_000},
        "messages":messages
    }))
    .unwrap();
    let response = transform(&store, &req, &context()).unwrap();
    let units = store
        .load(&req.session_id)
        .unwrap()
        .core
        .frozen_units
        .into_iter()
        .map(|unit| unit.key)
        .filter(|key| key.starts_with("strip:system_injected"))
        .collect();
    (units, serde_json::to_value(response.messages()).unwrap())
}

#[test]
fn system_message_strip_is_opencode_profile_only() {
    if !enabled() {
        return;
    }
    let (opencode, _) = run("opencode-aisdk", false);
    assert!(
        !opencode.is_empty(),
        "positive control must reach system stripping"
    );
    let (claude_code, _) = run("claude-code-anthropic", false);
    assert!(
        claude_code.is_empty(),
        "Claude Code minted system-message units: {claude_code:?}"
    );
}

#[test]
fn issue630_guard_holds_system_units_before_current_turn_thinking_on_both_profiles() {
    if !enabled() {
        return;
    }
    for profile in ["opencode-aisdk", "claude-code-anthropic"] {
        let (units, output) = run(profile, true);
        assert!(
            units.is_empty(),
            "protected system units minted on {profile}: {units:?}"
        );
        let messages = output.as_array().unwrap();
        let notification = messages
            .iter()
            .find(|m| m["meta"]["harness_id"] == "notification")
            .unwrap();
        assert!(notification["content"][0]["kind"]["text"]
            .as_str()
            .unwrap()
            .contains("<system-reminder>"));
        let signed = messages
            .iter()
            .find(|m| m["meta"]["harness_id"] == "signed")
            .unwrap();
        assert_eq!(signed["content"][0]["kind"]["signature"], "signed");
    }
}
