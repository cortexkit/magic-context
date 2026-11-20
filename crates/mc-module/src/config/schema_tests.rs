//! `assets/settings-schema.json` against the daemon's rules and against the
//! keys today's readers take.

use std::collections::BTreeSet;

use serde_json::{json, Value};
use subc_client_rs::config::{Layer, LayerValue, ValidationContext};

use super::review::{schema, schema_value};

fn context() -> ValidationContext {
    ValidationContext::new("magic-context", None)
}

fn review(user: Value) -> Result<subc_client_rs::config::ConfigView, String> {
    schema()
        .review_tuple(&[LayerValue::new(Layer::User, user)], &context())
        .map(|tuple| {
            subc_client_rs::config::ConfigView::new(
                1,
                tuple.effective,
                tuple.sources,
                vec![],
                subc_client_rs::config::ConfigStatus::Active,
            )
        })
        .map_err(|refusal| format!("{refusal:?}"))
}

#[test]
fn the_schema_follows_the_daemons_rules() {
    subc_client_rs::config::Schema::new(schema_value().clone())
        .expect("the daemon's rules accept it");
}

/// Every node under `node`, by pointer, with what kind of node it is.
fn walk<'a>(node: &'a Value, path: String, out: &mut Vec<(String, &'a Value)>) {
    out.push((path.clone(), node));
    for (key, child) in node["properties"].as_object().into_iter().flatten() {
        walk(child, super::edit::child(&path, key), out);
    }
    for child in node["patternProperties"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(_, child)| child)
    {
        walk(child, format!("{path}/*"), out);
    }
    if let Some(items) = node.get("items") {
        walk(items, format!("{path}/[]"), out);
    }
    for (index, branch) in node["oneOf"].as_array().into_iter().flatten().enumerate() {
        walk(branch, format!("{path}|{index}"), out);
    }
}

#[test]
fn every_node_carries_its_metadata_and_keeps_the_daemons_rules() {
    let mut nodes = Vec::new();
    walk(schema_value(), String::new(), &mut nodes);
    assert!(nodes.len() > 100, "{}", nodes.len());
    for (path, node) in nodes {
        let map = node.as_object().expect("a schema node is an object");
        for refused in [
            "allOf",
            "anyOf",
            "if",
            "then",
            "else",
            "$ref",
            "$dynamicRef",
        ] {
            assert!(!map.contains_key(refused), "{path}: {refused}");
        }
        assert_eq!(node["x-ck-apply"], "live", "{path}");
        assert_eq!(node["x-ck-layers"], json!(["user"]), "{path}");
        if path.is_empty() {
            continue;
        }
        assert!(
            node["description"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty()),
            "{path}: no description"
        );
        let union = map.contains_key("oneOf");
        if union {
            // A union carries no default: the default is merged as the
            // lowest layer, and a layer may not switch a union's variant.
            assert!(!map.contains_key("default"), "{path}");
            assert!(!map.contains_key("type"), "{path}");
            for branch in node["oneOf"].as_array().unwrap() {
                assert_eq!(branch["type"], "object", "{path}");
                assert!(
                    branch["required"]
                        .as_array()
                        .unwrap()
                        .contains(&json!("kind")),
                    "{path}"
                );
                assert!(branch["properties"]["kind"]["const"].is_string(), "{path}");
            }
            continue;
        }
        let kind = node["type"]
            .as_str()
            .unwrap_or_else(|| panic!("{path}: type is one string"));
        assert_ne!(kind, "null", "{path}");
        let section = kind == "object" && node.get("x-ck-kind").is_none();
        if section {
            assert_eq!(node["unevaluatedProperties"], false, "{path}");
            if let Some(patterns) = node["patternProperties"].as_object() {
                assert_eq!(patterns.len(), 1, "{path}");
                assert!(
                    node.get("additionalProperties")
                        .is_none_or(|open| open == false),
                    "{path}"
                );
            }
        }
        let required = node["x-ck-required"] == true;
        // A section holds fields and carries no value of its own. A union's
        // payload and a credential are required where they appear; every
        // other field has a default.
        if !section || node.get("patternProperties").is_some() {
            assert!(
                map.contains_key("default") != required,
                "{path}: exactly one of default and x-ck-required"
            );
        }
        if node["x-ck-kind"] == "credential_ref" {
            assert!(required, "{path}");
        }
    }
}

#[test]
fn every_union_variant_can_be_chosen_over_the_defaults() {
    for user in [
        json!({"protected_tokens": {"kind": "auto"}}),
        json!({"protected_tokens": {"kind": "tokens", "tokens": 4000}}),
        json!({"embedding": {"query_instruction": {"kind": "auto"}}}),
        json!({"embedding": {"query_instruction": {"kind": "none"}}}),
        json!({"embedding": {"query_instruction": {"kind": "text", "text": "q: "}}}),
        json!({"embedding": {"document_prefix": {"kind": "auto"}}}),
        json!({"embedding": {"document_prefix": {"kind": "text", "text": ""}}}),
        json!({"embedding": {"api_key": {"kind": "none"}}}),
        json!({"embedding": {"api_key": {"kind": "vault", "key": {"vault_ref": "openai"}}}}),
        json!({"rerank": {"api_key": {"kind": "vault", "key": {"vault_ref": "cohere"}}}}),
        json!({"dreamer": {"projects": {"kind": "all"}}}),
        json!({"dreamer": {"projects": {"kind": "listed", "projects": ["git:abc"]}}}),
    ] {
        review(user.clone()).unwrap_or_else(|refusal| panic!("{user}: {refusal}"));
    }
    for refused in [
        json!({"protected_tokens": {"kind": "tokens"}}),
        json!({"protected_tokens": 8000}),
        json!({"embedding": {"document_prefix": {"kind": "none"}}}),
        json!({"embedding": {"api_key": "sk-literal"}}),
        json!({"embedding": {"api_key": {"kind": "vault", "key": "sk-literal"}}}),
        json!({"embedding": {"endpoint": "{env:URL}"}}),
        json!({"clock_note": false}),
        json!({"dreamer": {"disable": true}}),
        json!({"temporal_awareness": true}),
    ] {
        assert!(review(refused.clone()).is_err(), "{refused}");
    }
}

/// The schema's fields by pointer, map entries as `*`.
fn schema_fields() -> BTreeSet<String> {
    super::review::fields()
        .iter()
        .flat_map(|field| {
            let node = schema_value()
                .pointer(&field.pointer.replace('/', "/properties/"))
                .unwrap_or_else(|| panic!("{}", field.pointer));
            if node.get("patternProperties").is_some() {
                vec![field.pointer.clone(), format!("{}/*", field.pointer)]
            } else {
                vec![field.pointer.clone()]
            }
        })
        .collect()
}

/// Every key today's readers take from the user's file, by pointer, with
/// `*` for a map's entries, from the code that reads it.
fn reader_keys() -> BTreeSet<String> {
    let mut keys: BTreeSet<String> = [
        // config.rs `resolve_tiers` and `execute_threshold`.
        "/execute_threshold_percentage",
        "/execute_threshold_percentage/*",
        "/execute_threshold_tokens",
        "/execute_threshold_tokens/*",
        "/keep_reasoning_tokens",
        "/keep_reasoning_tokens/*",
        "/protected_tokens",
        "/protected_tools",
        "/protected_tools/*",
        "/history_budget_percentage",
        "/memory/enabled",
        "/memory/auto_promote",
        "/memory/injection_budget_tokens",
        "/mural/enabled",
        "/memory/auto_search/enabled",
        "/memory/auto_search/score_threshold",
        "/memory/auto_search/min_prompt_chars",
        "/memory/git_commit_indexing/enabled",
        "/memory/git_commit_indexing/since_days",
        "/memory/git_commit_indexing/max_commits",
        "/language",
        "/keep_subagents",
        "/clock_note",
        // `commit_clusters` and `caveman`.
        "/commit_cluster_trigger/enabled",
        "/commit_cluster_trigger/min_clusters",
        "/caveman_text_compression/enabled",
        "/caveman_text_compression/min_chars",
        // `catalog_config` and `guidance_override`.
        "/prompt_surface/default",
        "/prompt_surface/models",
        "/prompt_surface/models/*",
        "/prompt_surface/tool_descriptions",
        "/prompt_surface/tool_descriptions/*",
        "/prompt_surface/guidance_override_path",
        "/prompt_surface/guidance_override_text",
        "/compaction/enabled",
        // embedding.rs: `module`, read on its own.
        "/embedding/module",
        // search/rerank.rs `Reranker::from_tiers_in`.
        "/rerank/provider",
        "/rerank/module",
        "/rerank/endpoint",
        "/rerank/model",
        "/rerank/api_key",
        "/rerank/timeout_ms",
        "/rerank/top_n",
        // `dreamer_settings`.
        "/dreamer/disable",
        "/dreamer/maxTokens",
        "/dreamer/projects",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    keys.extend(
        crate::embedding::USER_KEYS
            .iter()
            .map(|key| format!("/embedding/{key}")),
    );
    keys.extend(super::SECRET_SETTINGS.iter().map(|key| (*key).to_owned()));
    keys.extend(
        crate::dreamer::tasks()
            .iter()
            .map(|task| format!("/dreamer/tasks/{}/schedule", task.kind())),
    );
    keys
}

/// A reader key's field in the schema, where the schema renamed or
/// reshaped it.
fn renamed(key: &str) -> &str {
    match key {
        "/dreamer/disable" => "/dreamer/enabled",
        "/dreamer/maxTokens" => "/dreamer/max_tokens",
        other => other,
    }
}

#[test]
fn each_key_todays_reader_takes_appears_in_the_schema_and_no_other() {
    let fields = schema_fields();
    let readers: BTreeSet<String> = reader_keys()
        .iter()
        .map(|key| renamed(key).to_owned())
        .collect();
    let missing: Vec<_> = readers.difference(&fields).collect();
    assert!(
        missing.is_empty(),
        "read today, missing from the schema: {missing:?}"
    );
    // `rerank.enabled` is how the schema says `rerank.provider: "off"`.
    let extra: Vec<_> = fields
        .difference(&readers)
        .filter(|field| *field != "/rerank/enabled")
        .collect();
    assert!(
        extra.is_empty(),
        "in the schema, read by nothing today: {extra:?}"
    );
}

#[test]
fn the_dreamer_tasks_are_the_tasks_ck_mc_runs_with_their_default_schedules() {
    let registered: BTreeSet<&str> = crate::dreamer::tasks()
        .iter()
        .map(|task| task.kind())
        .collect();
    let listed: BTreeSet<&str> = super::convert::TASK_KINDS.into_iter().collect();
    assert_eq!(registered, listed);
    let tasks = schema_value()
        .pointer("/properties/dreamer/properties/tasks/properties")
        .and_then(Value::as_object)
        .unwrap();
    assert_eq!(
        tasks.keys().map(String::as_str).collect::<BTreeSet<_>>(),
        listed
    );
    for (kind, task) in tasks {
        assert_eq!(
            task["properties"]["schedule"]["default"],
            crate::dreamer::engine::default_schedule(kind),
            "{kind}"
        );
    }
}

#[test]
fn tool_descriptions_take_exactly_the_catalogs_tools() {
    let pattern = schema_value()
        .pointer("/properties/prompt_surface/properties/tool_descriptions/patternProperties")
        .and_then(Value::as_object)
        .and_then(|patterns| patterns.keys().next())
        .unwrap();
    let pattern = regex::Regex::new(pattern).unwrap();
    for tool in &crate::catalog::definition().tools {
        assert!(pattern.is_match(&tool.name), "{}", tool.name);
    }
    for other in ["todowrite", "ctx_reduce_x", "", "CTX_REDUCE"] {
        assert!(!pattern.is_match(other), "{other}");
    }
}

#[test]
fn model_maps_take_the_model_keys_todays_lookup_matches() {
    let pattern = regex::Regex::new(super::convert::MODEL_KEY_PATTERN).unwrap();
    for key in [
        "default",
        "anthropic/claude-opus-5-5",
        "claude-opus-5",
        "openai/*",
        "openrouter/anthropic/claude-3.5-sonnet",
        "google-vertex-anthropic/claude-3-5-sonnet@20240620",
        "qwen2.5:7b",
        "bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0",
    ] {
        assert!(pattern.is_match(key), "{key}");
    }
    // Every key today's lookup tries for a model is one a map can hold.
    for model in [
        "openrouter/anthropic/claude-3.5-sonnet",
        "openai-codex/gpt-5-codex",
        "google-vertex-anthropic/claude-3-5-sonnet@20240620",
        "ollama/qwen2.5:7b",
    ] {
        for key in super::model_key_lookup_order(model) {
            assert!(pattern.is_match(&key), "{model}: {key}");
        }
    }
    for key in ["", "a b", "/x", "x/", "x/ y"] {
        assert!(!pattern.is_match(key), "{key:?}");
    }
    for pointer in [
        "/execute_threshold_percentage",
        "/execute_threshold_tokens",
        "/keep_reasoning_tokens",
        "/prompt_surface/models",
    ] {
        let node = schema_value()
            .pointer(&pointer.replace('/', "/properties/"))
            .unwrap();
        assert_eq!(
            node["patternProperties"]
                .as_object()
                .unwrap()
                .keys()
                .next()
                .unwrap(),
            super::convert::MODEL_KEY_PATTERN,
            "{pointer}"
        );
    }
}

#[test]
fn the_schema_defaults_are_the_readers_defaults() {
    use super::UserTier;
    let defaults = schema().defaults();
    let from_code =
        super::resolve_for_test(json!({}), json!({}), "anthropic/claude-opus-5-5", 200_000);
    // Read as values the person set, every default resolves to what the
    // code does with nothing set; only the threshold's source says the
    // person set it.
    let tier = UserTier::from_managed(defaults.clone());
    let from_schema = super::resolve_for_test(
        tier.value().clone(),
        json!({}),
        "anthropic/claude-opus-5-5",
        200_000,
    );
    assert_eq!(from_schema.execute_threshold_source, "user_percentage");
    let mut relabelled = from_schema.clone();
    relabelled.execute_threshold_source = from_code.execute_threshold_source;
    super::equivalence_tests::assert_same(&relabelled, &from_code, "schema defaults");
    let path = std::path::Path::new("/settings/magic-context.jsonc");
    assert_eq!(
        format!(
            "{:?}",
            super::catalog_config(Some(tier.value()), None, path)
        ),
        format!("{:?}", super::catalog_config(None, None, path))
    );
    let dreamer = super::dreamer_settings(Some(tier.value())).unwrap();
    let default = crate::dreamer::engine::Settings::default();
    assert_eq!(dreamer.budget_tokens, default.budget_tokens);
    assert_eq!(dreamer.projects, default.projects);
    for kind in super::convert::TASK_KINDS {
        assert_eq!(
            dreamer.schedules.get(kind).map(String::as_str),
            Some(crate::dreamer::engine::default_schedule(kind)),
            "{kind}"
        );
    }
    // A delivered view marks the defaults as defaults, so the user tier
    // leaves them out.
    let view = review(json!({})).unwrap();
    assert_eq!(view.effective, defaults);
    let tier = UserTier::from_view(&view.effective, &view.sources);
    assert_eq!(tier.value(), &json!({}));
}

/// Each ranged field's bounds against the conversion: at the bounds the
/// schema takes the value and the converter keeps it; past them the schema
/// refuses it and the converter removes or corrects it, as today's reader
/// ignores or clamps it.
#[test]
fn ranges_are_the_ranges_the_readers_accept() {
    let mut nodes = Vec::new();
    walk(schema_value(), String::new(), &mut nodes);
    let mut checked = 0;
    for (path, node) in nodes {
        let Some(minimum) = node["minimum"].as_f64() else {
            continue;
        };
        // Union payloads and map entries are covered by the conversion's
        // tests; plain fields are written directly here.
        if path.contains('|') || path.contains('*') {
            continue;
        }
        let integer = node["type"] == "integer";
        let maximum = node["maximum"].as_f64();
        let at = |value: f64| {
            let mut file = "{}".to_owned();
            let number = if integer {
                json!(value as i64)
            } else {
                json!(value)
            };
            let keys = super::edit::keys(&path).unwrap();
            let path: Vec<_> = keys.iter().map(String::as_str).collect();
            subc_jsonc::set_member(&mut file, &path, &number).unwrap();
            serde_json::from_str::<Value>(&file).unwrap()
        };
        let step = if integer { 1.0 } else { 0.001 };
        let mut inside = vec![minimum];
        inside.extend(maximum);
        let mut outside = vec![minimum - step];
        outside.extend(maximum.map(|maximum| maximum + step));
        for value in inside {
            let file = at(value);
            review(file.clone()).unwrap_or_else(|refusal| panic!("{path} = {value}: {refusal}"));
            assert!(
                super::convert::convert_0_49(&file).0.is_empty(),
                "{path} = {value}"
            );
        }
        for value in outside {
            let file = at(value);
            assert!(review(file.clone()).is_err(), "{path} = {value}");
            let (edits, _) = super::convert::convert_0_49(&file);
            assert!(
                !edits.is_empty(),
                "{path} = {value}: the converter keeps it"
            );
        }
        checked += 1;
    }
    assert!(checked >= 13, "{checked}");
}
