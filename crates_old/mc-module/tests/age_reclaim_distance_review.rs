use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_module::config::CacheTtlProvenance;
use mc_module::transform::{transform, ProducerContext, TransformRequest};
use mc_store::McStore;
use serde_json::{json, Value};

fn context() -> ProducerContext<'static> {
    ProducerContext {
        project_path: "git:age-review",
        note_project_path: "git:age-review",
        project_directory: "/nonexistent-docs",
        history_budget_tokens: 60_000.0,
        memory_budget_tokens: 8_000.0,
        user_profile_budget_tokens: 4_000.0,
        memory_enabled: true,
        inject_docs: false,
        temporal_awareness: false,
        now_ms: 1,
        execute_threshold_percentage: 65.0,
        protected_tokens_floor: 0,
        protected_tokens_provenance: "configured",
        compaction_enabled: true,
        smart_drops: false,
        protected_tools: Default::default(),
        cache_ttl: "5m".into(),
        cache_ttl_provenance: CacheTtlProvenance::Default,
        cache_ttl_policy: None,
        model_key: None,
        observed_last_response_at_ms: None,
        guidance_date: Some("Today's date: Fri Jan 15 2027".into()),
        historian_active: false,
        wrapup_active: false,
        // The hold is off by default; this review exercises the default configuration.
        signed_thinking_hold: mc_module::config::SignedThinkingHold::Off,
        caveman_english_word_rules: true,
    }
}
fn store() -> (tempfile::TempDir, McStore) {
    let root = std::env::temp_dir().join("magic-context/age-reclaim-review");
    std::fs::create_dir_all(&root).unwrap();
    let dir = tempfile::tempdir_in(root).unwrap();
    let descriptor = StorageDescriptor {
        module_id: "age-review".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into(),
        },
    };
    let store = McStore::open_for_test(&descriptor).unwrap();
    (dir, store)
}
fn msg(id: &str, ordinal: u64, role: &str, kind: Value) -> Value {
    json!({"mid":id,"ordinal":ordinal,"ck":{"role":role,"content":[{"kind":kind}],"meta":{"harness_id":id}}})
}
fn text(id: &str, ordinal: u64, role: &str, text: &str) -> Value {
    msg(id, ordinal, role, json!({"type":"text","text":text}))
}
fn call(id: &str, ordinal: u64) -> Value {
    msg(
        id,
        ordinal,
        "assistant",
        json!({"type":"tool_call","id":id,"name":"bash","input":{"command":format!("inspect {id}")}}),
    )
}
fn result(id: &str, ordinal: u64, arc: &str) -> Value {
    msg(
        id,
        ordinal,
        "tool",
        json!({"type":"tool_result","id":arc,"tool_name":"bash","output":{"kind":{"type":"text","text":format!("{id} {}", "payload ".repeat(800))}}}),
    )
}
fn request(messages: Vec<Value>, known: bool) -> TransformRequest {
    let mut raw = json!({"kind":"transform","v":2,"serializer_profile":"opencode-aisdk","session_id":"review","render_config":"cfg0","tool_present":true,"auto_search_enabled":false,"provider_id":"review","model_key":"review/unknown","protected_tokens_effective":0,"messages":messages});
    if known {
        raw["usage"] = json!({"current_total_input_tokens":4000,"context_limit_tokens":200_000,"final_wire_input_tokens":0,"final_wire_trusted":false});
    }
    serde_json::from_value(raw).unwrap()
}

#[test]
fn synthetic_wakes_must_not_advance_the_age_bookmark() {
    let (_dir, store) = store();
    let mut messages = vec![
        text("head", 1, "user", "one task"),
        call("old", 2),
        result("old-result", 3, "old"),
    ];
    for index in 0..3 {
        let mut wake = text(
            &format!("wake-{index}"),
            4 + index,
            "user",
            "<system-reminder>Background task finished.</system-reminder>",
        );
        wake["ck"]["meta"]["synthetic"] = json!(true);
        messages.push(wake);
    }
    transform(&store, &request(messages, true), &context()).unwrap();
    assert_eq!(store.load("review").unwrap().meta.last_execute_ordinal, 0);
}

#[test]
fn unknown_geometry_must_disable_token_distance() {
    let (_dir, store) = store();
    let messages = vec![
        text("head", 1, "user", "one task"),
        call("old", 2),
        result("old-result", 3, "old"),
        text("tail", 4, "assistant", &"newer content ".repeat(40_000)),
    ];
    transform(&store, &request(messages, false), &context()).unwrap();
    assert_eq!(store.load("review").unwrap().meta.last_execute_ordinal, 0);
}

#[test]
fn parallel_batch_waits_for_its_last_result_before_aging() {
    let (_dir, store) = store();
    let mut batch = call("batch", 2);
    batch["ck"]["content"] = json!([
        {"kind":{"type":"tool_call","id":"slow","name":"bash","input":{"command":"slow"}}},
        {"kind":{"type":"tool_call","id":"fast","name":"bash","input":{"command":"fast"}}},
        {"kind":{"type":"tool_call","id":"bulk","name":"bash","input":{"command":"bulk"}}}
    ]);
    let mut bulk = result("bulk-result", 4, "bulk");
    bulk["ck"]["content"][0]["kind"]["output"]["kind"]["text"] =
        json!("newer content ".repeat(40_000));
    let mut messages = vec![
        text("head", 1, "user", "one task"),
        batch,
        result("fast-result", 3, "fast"),
        bulk,
        result("slow-result", 5, "slow"),
    ];
    // Separate recent calls carry the continuation protection, not the old slow call.
    for index in 0..3 {
        messages.push(call(&format!("guard-{index}"), 6 + index * 2));
        messages.push(result(
            &format!("guard-result-{index}"),
            7 + index * 2,
            &format!("guard-{index}"),
        ));
    }
    let req = request(messages, true);
    let mut ctx = context();
    transform(&store, &req, &ctx).unwrap();
    assert_eq!(store.load("review").unwrap().meta.last_execute_ordinal, 0);
    ctx.now_ms = 360_002;
    ctx.observed_last_response_at_ms = Some(2);
    transform(&store, &req, &ctx).unwrap();
    assert!(
        !store
            .load("review")
            .unwrap()
            .core
            .frozen_units
            .iter()
            .any(|unit| unit.key == "red:slow-result#0"),
        "the slow result arrived at the tail with no newer user turns or token mass"
    );
}

#[test]
fn real_image_only_users_count() {
    let (_dir, store) = store();
    let mut messages = vec![
        text("head", 1, "user", "one task"),
        call("old", 2),
        result("old-result", 3, "old"),
    ];
    for index in 0..3 {
        messages.push(msg(&format!("image-{index}"),4+index,"user",json!({"type":"media","kind":"image","source":{"type":"url","url":"https://example.invalid/image.png"},"media_type":"image/png"})));
    }
    // The concrete media wire schema is intentionally deserialized by the real entry point.
    transform(&store, &request(messages, true), &context()).unwrap();
    assert_eq!(store.load("review").unwrap().meta.last_execute_ordinal, 2);
}

#[test]
fn newer_image_mass_must_contribute_to_token_distance() {
    let (_dir, store) = store();
    let mut messages = vec![
        text("head", 1, "user", "one task"),
        call("old", 2),
        result("old-result", 3, "old"),
    ];
    // Remote images have the normal estimator's 1,200-token fallback: 50,400 total.
    for index in 0..42 {
        messages.push(msg(&format!("image-{index}"),4+index,"assistant",json!({"type":"media","kind":"image","source":{"type":"url","url":"https://example.invalid/image.png"},"media_type":"image/png"})));
    }
    transform(&store, &request(messages, true), &context()).unwrap();
    assert_eq!(store.load("review").unwrap().meta.last_execute_ordinal, 2);
}

#[test]
fn injected_heads_reminders_and_tool_only_user_carriers_are_not_turns() {
    let (_dir, store) = store();
    let mut messages = vec![text("head", 1, "user", "one task"), call("old", 2)];
    let mut carrier = result("old-result", 3, "old");
    carrier["ck"]["role"] = json!("user");
    messages.push(carrier);
    for index in 0..3 {
        let mut head = text(
            &format!("mc_head_{index}"),
            4 + index * 2,
            "user",
            "injected history summary",
        );
        head["ck"]["meta"]["synthetic"] = json!(true);
        messages.push(head);
        messages.push(text(
            &format!("note-{index}"),
            5 + index * 2,
            "user",
            "<instruction name=\"deferred_notes\">remember</instruction>",
        ));
    }
    transform(&store, &request(messages, true), &context()).unwrap();
    assert_eq!(store.load("review").unwrap().meta.last_execute_ordinal, 0);
}
