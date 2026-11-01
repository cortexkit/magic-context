//! Executes the production transform entry point against a real SQLite store.
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_module::config::CacheTtlProvenance;
use mc_module::transform::{transform, ProducerContext, TransformRequest, TransformResponse};
use mc_store::McStore;
use serde_json::json;

fn descriptor(path: &std::path::Path) -> StorageDescriptor {
    StorageDescriptor {
        module_id: "cold-flip-review".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: path.join("store.db").to_string_lossy().into(),
        },
    }
}

fn context() -> ProducerContext<'static> {
    ProducerContext {
        project_path: "git:review",
        note_project_path: "git:review",
        project_directory: "/nonexistent-docs",
        history_budget_tokens: 60_000.0,
        memory_budget_tokens: 8_000.0,
        user_profile_budget_tokens: 4_000.0,
        memory_enabled: true,
        inject_docs: false,
        temporal_awareness: true,
        now_ms: 0,
        execute_threshold_percentage: 65.0,
        protected_tokens_floor: 16_000,
        protected_tokens_provenance: "derived",
        compaction_enabled: true,
        signed_thinking_hold: mc_module::config::SignedThinkingHold::Off,
        smart_drops: false,
        protected_tools: [("todowrite".to_string(), 1), ("ctx_reduce".to_string(), 3)].into(),
        cache_ttl: "5m".into(),
        cache_ttl_provenance: CacheTtlProvenance::Default,
        cache_ttl_policy: None,
        model_key: None,
        observed_last_response_at_ms: None,
        guidance_date: Some("Today's date: Thu Jan 01 1970".into()),
        historian_active: false,
        wrapup_active: false,
        caveman_english_word_rules: true,
    }
}

fn request(profile: &str) -> TransformRequest {
    serde_json::from_value(json!({
        "kind": "transform", "v": 2, "serializer_profile": profile,
        "session_id": "review", "render_config": "cfg0", "tool_present": false,
        "auto_search_enabled": false,
        "messages": (1..=8).map(|n| json!({
            "mid": format!("m{n}"), "ordinal": n,
            "ck": { "role": "user", "content": [{"kind": {"type": "text", "text": format!("message {n} {}", "stable prefix ".repeat(4096))}}],
                "meta": {"harness_id": format!("m{n}"), "created_at_ms": n * 600_000}}
        })).collect::<Vec<_>>()
    })).unwrap()
}

fn run(store: &McStore, request: &TransformRequest) -> TransformResponse {
    transform(store, request, &context()).unwrap()
}
fn bytes(response: &TransformResponse) -> Vec<u8> {
    serde_json::to_vec(response.messages()).unwrap()
}
fn tagged(response: &TransformResponse) -> bool {
    String::from_utf8(bytes(response)).unwrap().contains("§1§")
}
fn quiet(store: &McStore, request: &TransformRequest, expected: &[u8]) {
    for _ in 0..8 {
        let response = run(store, request);
        assert_ne!(response.action, "HARD", "quiet pass must not bust");
        assert_eq!(
            bytes(&response),
            expected,
            "quiet pass changed served bytes"
        );
    }
}

#[test]
fn dormant_flip_readd_and_restart_are_single_hard() {
    for profile in ["opencode-aisdk", "claude-code-anthropic"] {
        let dir = tempfile::tempdir().unwrap();
        let mut store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        let mut request = request(profile);
        let dormant = run(&store, &request);
        assert_eq!(dormant.action, "HARD");
        assert!(!tagged(&dormant));
        quiet(&store, &request, &bytes(&dormant));
        for restart in [false, true] {
            if restart {
                drop(store);
                store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
            }
            let before = store.load("review").unwrap();
            assert!(!before.meta.tagging_surface_active);
            request.tool_present = true;
            let transition = run(&store, &request);
            assert_eq!(transition.action, "HARD");
            assert!(
                tagged(&transition),
                "transition must serve tags immediately"
            );
            let wire = String::from_utf8(bytes(&transition)).unwrap();
            for n in 1..=8 {
                assert!(wire.contains(&format!("§{n}§")), "missing tag {n}");
            }
            let after = store.load("review").unwrap();
            assert_ne!(
                before.meta.last_render_config,
                after.meta.last_render_config
            );
            assert!(after.meta.tagging_surface_active);
            quiet(&store, &request, &bytes(&transition));
            drop(store);
            store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
            quiet(&store, &request, &bytes(&transition));
            request.tool_present = false;
            let disabled = run(&store, &request);
            assert!(!tagged(&disabled));
            quiet(&store, &request, &bytes(&disabled));
        }
    }
}

#[test]
fn subagent_flip_defers_served_tags_and_tags_new_tail_on_first_sight() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
    let mut request = request("opencode-aisdk");
    request.is_subagent = true;
    let before = run(&store, &request);
    request.tool_present = true;
    let transition = run(&store, &request);
    // The surface flip spends one intentional Soft pass tagging previously served
    // content; a new tail message is still tagged on first sight on a later defer.
    let mut raw = serde_json::to_value(&request).unwrap();
    raw["messages"].as_array_mut().unwrap().push(json!({
        "mid": "m9", "ordinal": 9,
        "ck": { "role": "user", "content": [{"kind": {"type": "text", "text": "new tail"}}],
            "meta": {"harness_id": "m9", "created_at_ms": 5_400_000}}
    }));
    let mut grown: TransformRequest = serde_json::from_value(raw).unwrap();
    let first_sight = run(&store, &grown);
    let replay = run(&store, &grown);
    assert!(!store.load("review").unwrap().meta.initialized);
    assert_eq!(before.action, "SOFT+");
    assert_eq!(transition.action, "SOFT");
    assert!(!tagged(&before));
    assert!(tagged(&transition));
    assert_eq!(first_sight.action, "SOFT+");
    let wire = String::from_utf8(bytes(&first_sight)).unwrap();
    // First-sight tags remain additive on a defer, but new temporal choices
    // wait for a rebuilding pass so they cannot change the frozen prefix.
    assert!(wire.contains("§9§ new tail"));
    assert!(!wire.contains("§9§ <!-- +10m -->"));
    assert!(wire.contains("§1§ message 1"));
    assert_eq!(replay.action, "SOFT+");
    assert_eq!(bytes(&first_sight), bytes(&replay));
    grown.usage = Some(
        serde_json::from_value(json!({
            "current_total_input_tokens": 96_000,
            "context_limit_tokens": 100_000,
            "final_wire_input_tokens": 0,
            "final_wire_trusted": false
        }))
        .unwrap(),
    );
    let rebuilt = run(&store, &grown);
    assert_eq!(rebuilt.action, "SOFT");
    assert!(String::from_utf8(bytes(&rebuilt))
        .unwrap()
        .contains("§9§ <!-- +10m -->"));
    grown.usage.as_mut().unwrap().current_total_input_tokens = 1_000;
    let rebuilt_replay = run(&store, &grown);
    assert_eq!(rebuilt_replay.action, "SOFT+");
    assert_eq!(bytes(&rebuilt), bytes(&rebuilt_replay));
}

#[test]
fn temporal_quiet_active_session_does_not_invent_transition() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
    let mut request = request("opencode-aisdk");
    request.tool_present = true;
    let first = run(&store, &request);
    assert_eq!(first.action, "HARD");
    assert!(tagged(&first));
    assert!(!serde_json::to_string(&store.load("review").unwrap().core)
        .unwrap()
        .contains("migration:renderer-transition"));
    quiet(&store, &request, &bytes(&first));
}

#[test]
fn lifecycle_cas_advances_do_not_repeat_surface_transition() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
    let mut request = request("opencode-aisdk");
    run(&store, &request);
    request.tool_present = true;
    let transition = run(&store, &request);
    assert_eq!(transition.action, "HARD");
    assert_eq!(transition.row_version, 2);
    let core = serde_json::to_value(&store.load("review").unwrap().core).unwrap();
    assert!(core.to_string().contains("temporal_parity"));
    for n in 0..10 {
        let mut historian = store.load("review").unwrap().meta.historian;
        historian.last_no_fire = Some(format!("review observation {n}"));
        mc_module::historian::persist_historian_state(&store, "review", historian).unwrap();
    }
    assert_eq!(
        serde_json::to_value(&store.load("review").unwrap().core).unwrap(),
        core
    );
    assert_eq!(store.load("review").unwrap().row_version, Some(12));
    quiet(&store, &request, &bytes(&transition));
}

#[test]
fn identity_fold_without_temporal_parity_tags_on_the_same_hard() {
    for profile in ["opencode-aisdk", "claude-code-anthropic"] {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        let mut request = request(profile);
        for message in &mut request.messages {
            message.ck.meta.created_at_ms = None;
            message.ck.mark_modified();
        }
        let dormant = run(&store, &request);
        quiet(&store, &request, &bytes(&dormant));
        let old_identity = store.load("review").unwrap().meta.last_render_config;
        assert!(!old_identity.contains("tfe:"));
        request.tool_present = true;
        let transition = run(&store, &request);
        assert_eq!(transition.action, "HARD");
        assert!(tagged(&transition));
        let loaded = store.load("review").unwrap();
        assert!(loaded.meta.last_render_config.contains("tfe:4:tfe4"));
        assert!(!serde_json::to_string(&loaded.core)
            .unwrap()
            .contains("temporal_parity"));
        quiet(&store, &request, &bytes(&transition));
    }
}
