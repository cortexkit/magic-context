//! Engine-owned temporal choices may differ at a priced mode switch, then freeze.
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_module::config::CacheTtlProvenance;
use mc_module::transform::{transform, ProducerContext, TransformRequest};
use mc_store::McStore;
use serde_json::Value;

fn users(response: &mc_module::transform::TransformResponse) -> Value {
    let messages = serde_json::to_value(response.messages()).unwrap();
    Value::Array(
        messages
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| {
                message["role"] == "user"
                    && ["user", "later", "near"]
                        .contains(&message["meta"]["harness_id"].as_str().unwrap_or(""))
            })
            .map(|message| message["content"][0]["kind"]["text"].clone())
            .collect(),
    )
}

#[test]
fn cold_rust_mode_rebuilds_its_own_choice_then_replays_stably() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../testdata/temporal-mode-switch.json")).unwrap();
    let mut request: TransformRequest = serde_json::from_value(fixture["request"].clone()).unwrap();
    let base = std::env::temp_dir().join("magic-context/temporal-mode-switch");
    std::fs::create_dir_all(&base).unwrap();
    let directory = tempfile::Builder::new()
        .prefix("switch-")
        .tempdir_in(base)
        .unwrap();
    let root = directory.path().canonicalize().unwrap();
    let context_path = root.join("context.db");
    let ts = rusqlite::Connection::open(&context_path).unwrap();
    ts.execute_batch(include_str!("fixtures/context-db-schema.sql"))
        .unwrap();
    ts.execute("INSERT INTO single_store_state(id,state,migrated_by) VALUES (1,'migrated','temporal-mode-test')", []).unwrap();
    ts.execute(
        "INSERT INTO session_meta(session_id,harness) VALUES (?,'opencode')",
        [&request.session_id],
    )
    .unwrap();
    ts.execute("INSERT INTO temporal_decisions(session_id,message_id,marker) VALUES (?,'user','<!-- +5m -->\n')", [&request.session_id]).unwrap();
    let store = McStore::open_for_test(&StorageDescriptor {
        module_id: "temporal-mode-switch".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: root.join("store.db").to_string_lossy().into(),
        },
    })
    .unwrap();
    let mut context = ProducerContext {
        project_path: "git:temporal-mode",
        note_project_path: "git:temporal-mode",
        project_directory: "/nonexistent-docs",
        history_budget_tokens: 60_000.0,
        memory_budget_tokens: 8_000.0,
        user_profile_budget_tokens: 4_000.0,
        memory_enabled: true,
        inject_docs: false,
        temporal_awareness: true,
        now_ms: 1_000,
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
    };
    let switched = transform(&store, &request, &context).unwrap();
    assert_eq!(
        switched.action, "HARD",
        "cold mode activation is a rebuilding pass"
    );
    assert_eq!(users(&switched), fixture["rust_users"]);
    let ts_marker: String = ts
        .query_row(
            "SELECT marker FROM temporal_decisions WHERE session_id=? AND message_id='user'",
            [&request.session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        ts_marker, "<!-- +5m -->\n",
        "the TS authority is not overwritten by Rust"
    );

    // A later observation would now suggest no gap. Only the cold rebuilding
    // pass chose +10m; the subsequent native defers must replay that choice.
    request.messages[0].ck.meta.completed_at_ms = Some(600_000);
    for pass in 0..3 {
        context.now_ms = 2_000 + pass;
        let replay = transform(&store, &request, &context).unwrap();
        assert_eq!(replay.action, "SOFT+");
        assert_eq!(users(&replay), fixture["rust_users"]);
    }
    #[cfg(unix)]
    {
        let output = std::process::Command::new("lsof")
            .args(["-p", &std::process::id().to_string()])
            .output()
            .unwrap();
        assert!(output.status.success());
        let output = String::from_utf8(output.stdout).unwrap();
        let handles: Vec<_> = output.lines().filter(|line| line.contains(".db")).collect();
        assert!(!handles.is_empty());
        for handle in handles {
            assert!(
                handle.contains(root.to_str().unwrap()),
                "non-throwaway database: {handle}"
            );
            println!("ISOLATION {handle}");
        }
    }
}
