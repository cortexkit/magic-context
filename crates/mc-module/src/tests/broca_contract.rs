//! The contract a Broca-hosted session relies on before the transform is switched on
//! for it. The caller must pin the same manifest text it reports; these
//! tests pin the parts a caller caches: the facade tool array it declares once per
//! session, and what the transform serves on the first and second send under the
//! `owned-broca` serializer profile.

use super::*;

/// The facade tools a Broca mason may declare. `transform` is a module tool too, but
/// only Broca's transform plane calls it; a model must never see it.
const BROCA_FACADE_TOOL_NAMES: [&str; 5] = [
    "ctx_reduce",
    "ctx_memory",
    "ctx_expand",
    "ctx_search",
    "ctx_note",
];

/// Set this variable to rewrite the golden files from the current module output.
const BLESS_ENV: &str = "MC_BLESS_BROCA_FACADE_GOLDENS";

fn golden_path(preset: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join(format!("broca-facade-tools-{preset}.json"))
}

async fn served_facade_tools(handler: &McHandler, preset: &str) -> Value {
    let response = call_dispatch_request(
        handler,
        json!({
            "kind": "manifest.get",
            "session_id": "ses",
            "preset": preset,
        }),
    )
    .await;
    assert_eq!(
        response["ok"],
        json!(true),
        "manifest.get failed: {response}"
    );
    assert_eq!(response["served_preset"], json!(preset));
    assert_eq!(response["preset_fallback"], json!(false));
    response["tools"].clone()
}

fn tool_names(tools: &Value) -> Vec<String> {
    tools
        .as_array()
        .expect("tools must be an array")
        .iter()
        .map(|tool| tool["name"].as_str().expect("tool name").to_string())
        .collect()
}

/// The served definitions are compared both as JSON values and as the exact pretty
/// bytes, so a reordered schema key fails here too: providers cache on bytes.
#[tokio::test(flavor = "current_thread")]
async fn broca_facade_tool_arrays_match_the_per_preset_goldens() {
    for preset in ["full", "light"] {
        let (handler, _store, _dir, _project) =
            handler_with_store(Arc::new(ProducerState::default()), default_test_config());
        let served = served_facade_tools(&handler, preset).await;
        let served_bytes = format!("{}\n", serde_json::to_string_pretty(&served).unwrap());
        let path = golden_path(preset);
        if std::env::var_os(BLESS_ENV).is_some() {
            std::fs::write(&path, &served_bytes).unwrap();
            continue;
        }
        let golden_bytes = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        let golden: Value = serde_json::from_str(&golden_bytes).unwrap();
        assert_eq!(
            served,
            golden,
            "served {preset} facade tools drifted from {}; a changed tool array busts every \
             Broca session's cached prefix, so update the golden only on purpose (set {BLESS_ENV}=1)",
            path.display()
        );
        assert_eq!(
            served_bytes,
            golden_bytes,
            "served {preset} facade tool bytes drifted from {}",
            path.display()
        );
        assert_eq!(tool_names(&served), BROCA_FACADE_TOOL_NAMES);
    }
}

/// The array does not depend on anything a caller might vary between sessions except the
/// preset: `memory.enabled` does not hide `ctx_memory`, the dreamer-only `ctx_memory_list`
/// never appears, and the startup manifest carries the same full-preset definitions plus
/// the internal `transform` tool.
#[tokio::test(flavor = "current_thread")]
async fn broca_facade_tool_array_ignores_memory_config_and_matches_the_startup_manifest() {
    let full_golden: Value =
        serde_json::from_str(&std::fs::read_to_string(golden_path("full")).unwrap()).unwrap();
    let light_golden: Value =
        serde_json::from_str(&std::fs::read_to_string(golden_path("light")).unwrap()).unwrap();
    assert_eq!(tool_names(&full_golden), tool_names(&light_golden));
    assert_ne!(full_golden, light_golden, "light must differ only in prose");

    let mut memory_off = default_test_config();
    memory_off.memory_enabled = false;
    let (handler, _store, _dir, _project) =
        handler_with_store(Arc::new(ProducerState::default()), memory_off);
    for (preset, golden) in [("full", &full_golden), ("light", &light_golden)] {
        let served = served_facade_tools(&handler, preset).await;
        assert_eq!(
            &served, golden,
            "memory.enabled=false changed the {preset} array"
        );
    }

    let startup = serde_json::to_value(manifest(DEFAULT_MODULE_ID)).unwrap();
    let startup_tools =
        find_tools_array(&startup["provides"]).expect("startup manifest declares a tool provider");
    let startup_names = startup_tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(startup_names.contains(&"transform"));
    assert!(!startup_names.contains(&"ctx_memory_list"));
    let startup_facades = startup_tools
        .iter()
        .filter(|tool| tool["name"] != json!("transform"))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(Value::Array(startup_facades), full_golden);
}

/// Find the first `tools` array under a serialized manifest value, whatever the role
/// enum's serde tagging looks like.
fn find_tools_array(value: &Value) -> Option<&Vec<Value>> {
    match value {
        Value::Object(fields) => fields
            .get("tools")
            .and_then(Value::as_array)
            .or_else(|| fields.values().find_map(find_tools_array)),
        Value::Array(items) => items.iter().find_map(find_tools_array),
        _ => None,
    }
}

#[test]
fn legacy_bridge_startup_ctx_reduce_schema_bytes_are_pinned() {
    // subc-mcp tools/list copies the startup manifest's schema unchanged into
    // inputSchema. Pin those bytes, not tool.catalog's structural digest: the
    // Claude Code gateway (thalamus-core tool_surface.rs,
    // canonical_ctx_reduce_schema) checks this exact shape before it arms
    // reduction, and refuses a schema it does not recognise. Adding the `drop`
    // description on 2026-09-22 left Claude Code without reduction for nine
    // days without any error. Any change here must be coordinated with the
    // gateway owner first.
    let startup = serde_json::to_value(manifest(DEFAULT_MODULE_ID)).unwrap();
    let tools = find_tools_array(&startup["provides"]).unwrap();
    let reduce = tools
        .iter()
        .find(|tool| tool["name"] == "ctx_reduce")
        .unwrap();
    let expected = br#"{"additionalProperties":false,"properties":{"drop":{"description":"Tag IDs to drop: \"3-5\", \"1,2,9\", \"1-5,8,12-15\".","type":"string"}},"required":["drop"],"type":"object"}"#;
    assert_eq!(
        serde_json::to_vec(&reduce["schema"]).unwrap(),
        expected,
        "changing the startup reduce schema can silently disarm Claude Code reduction"
    );
}

/// Build one request exactly as Broca's transform plane sends it: the `owned-broca`
/// profile, the profile folded into `render_config`, and the fields the module does not
/// read today (`agent_drop_ids`, `cache_ttl_ms`) left in so the test sends the real shape.
fn broca_transform_request(messages: &[CkIngressMessage], input_tokens: u64) -> Value {
    json!({
        "kind": "transform",
        "v": 1,
        "serializer_profile": "owned-broca",
        "session_id": "ses",
        "render_config": "owned-broca\u{241f}rc-contract",
        "messages": messages,
        "usage": {
            "current_total_input_tokens": input_tokens,
            "context_limit_tokens": 200_000,
        },
        "cache_ttl_ms": 300_000,
        "agent_drop_ids": [],
    })
}

/// `guidance.get` under `owned-broca` serves the reduce-capable variant exactly when the
/// caller's tool array includes `ctx_reduce`, and the variant that says it is unavailable
/// otherwise.
#[tokio::test(flavor = "current_thread")]
async fn owned_broca_guidance_variant_follows_ctx_reduce_presence() {
    let (handler, _store, _dir, _project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    for (tool_present, variant) in [
        (true, crate::prompt_surface::GuidanceVariant::Full),
        (false, crate::prompt_surface::GuidanceVariant::NoReduce),
    ] {
        let response = call_dispatch_request(
            &handler,
            json!({
                "kind": "guidance.get",
                "session_id": "ses",
                "serializer_profile": "owned-broca",
                "tool_present": tool_present,
            }),
        )
        .await;
        assert_eq!(response["ok"], json!(true), "{response}");
        let expected = typescript_legacy_guidance(
            if matches!(variant, crate::prompt_surface::GuidanceVariant::Full) {
                "full"
            } else {
                "no_reduce"
            },
        );
        assert!(
            response["bytes"].as_str().unwrap().starts_with(&expected),
            "tool_present={tool_present} served the wrong guidance variant"
        );
    }
}

/// Broca's names for three request fields. `cache_ttl_ms` feeds the cache-expiry
/// prediction and `overflow_error_text` the provider-overflow detection, each only when
/// the module's own field is absent. `agent_drop_ids` is accepted and ignored: `ctx_reduce`
/// calls land in the module's durable drop queue, so a caller-side copy would be a second
/// source of truth.
#[test]
fn owned_broca_wire_aliases_fill_the_module_fields() {
    let base = broca_transform_request(&[ck("u1", 1, "hi")], 0);
    let mut broca = base.clone();
    broca["cache_ttl_ms"] = json!(3_600_000);
    broca["overflow_error_text"] = json!("prompt is too long: 250000 tokens > 200000 maximum");
    broca["agent_drop_ids"] = json!(["u1"]);
    let parsed: crate::transform::TransformRequest = serde_json::from_value(broca).unwrap();
    assert_eq!(parsed.cache_ttl.as_deref(), Some("3600000"));
    assert_eq!(
        crate::scheduler::parse_cache_ttl(parsed.cache_ttl.as_deref().unwrap()),
        Ok(3_600_000)
    );
    assert_eq!(
        parsed.provider_error.as_deref(),
        Some("prompt is too long: 250000 tokens > 200000 maximum")
    );

    let mut both = base.clone();
    both["cache_ttl"] = json!("5m");
    both["cache_ttl_ms"] = json!(3_600_000);
    both["provider_error"] = json!("ours");
    both["overflow_error_text"] = json!("theirs");
    let parsed: crate::transform::TransformRequest = serde_json::from_value(both).unwrap();
    assert_eq!(parsed.cache_ttl.as_deref(), Some("5m"));
    assert_eq!(parsed.provider_error.as_deref(), Some("ours"));

    let mut without = base;
    without.as_object_mut().unwrap().remove("cache_ttl_ms");
    let parsed: crate::transform::TransformRequest = serde_json::from_value(without).unwrap();
    assert_eq!(parsed.cache_ttl, None);
    assert_eq!(parsed.provider_error, None);
}
