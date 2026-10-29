//! `tool.catalog` and `role.describe` against pinned payloads.
//!
//! `src/tests/fixtures/tool-catalog/` holds the exact bytes the module must serve
//! for each example request under `config.json` (prompt surface, tool enablement,
//! and guidance feature flags), and
//! `testdata/tool-catalog-guidance-matrix.json` the digest of every guidance text
//! for every combination of config inputs. Both are written by
//! `gen/gen-tool-catalog.ts` from the same shared definition the module serves from, so these
//! tests hold the generator's TypeScript renderer and this module's Rust one to
//! the same bytes.

use std::collections::BTreeMap;
use std::path::PathBuf;

use cortexkit_role_tool_provider::check_capability_tag;

use super::*;
use crate::tool_catalog::{self, CatalogConfig, CatalogError, Surface, TextFlags};

fn examples_dir() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tests/fixtures/tool-catalog")
}

/// The example config, as `config.json` records it.
fn example_config_json() -> Value {
    let text = std::fs::read_to_string(examples_dir().join("config.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

/// The example config as the catalog resolves it. The examples carry no
/// guidance override, so the override's digest must be absent.
fn example_catalog_config() -> CatalogConfig {
    let config = &example_config_json()["config"];
    assert!(config["guidance_override_sha256"].is_null());
    let surface = |value: &Value| match value.as_str() {
        Some("full") => Surface::Full,
        Some("light") => Surface::Light,
        other => panic!("not a surface: {other:?}"),
    };
    CatalogConfig {
        smart_notes_enabled: true,
        compaction_enabled: config["compaction_enabled"].as_bool().unwrap(),
        memory_enabled: config["memory_enabled"].as_bool().unwrap(),
        dreamer_runnable: config["dreamer_runnable"].as_bool().unwrap(),
        temporal_awareness: config["temporal_awareness"].as_bool().unwrap(),
        caveman_text_compression: config["caveman_text_compression"].as_bool().unwrap(),
        language: config["language"].as_str().map(str::to_string),
        surface_default: surface(&config["prompt_surface"]["default"]),
        surface_models: config["prompt_surface"]["models"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), surface(value)))
            .collect(),
        guidance_override: None,
        tool_descriptions: serde_json::from_value(config["tool_descriptions"].clone()).unwrap(),
        disabled_tools: serde_json::from_value(config["disabled_tools"].clone()).unwrap(),
    }
}

/// The same example config as the module holds it after reading the user and
/// project tiers (`config::merge_tiers_with_warnings` is tested on its own).
pub(super) fn example_module_config() -> McModuleConfig {
    let mut config = default_test_config();
    config.catalog = crate::config::CatalogConfigInputs {
        prompt_surface_default: Some("full".to_string()),
        prompt_surface_models: BTreeMap::from([(
            "anthropic/claude-haiku-4-5".to_string(),
            "light".to_string(),
        )]),
        tool_descriptions: BTreeMap::new(),
        dreamer_runnable: true,
    };
    config.memory_enabled = true;
    config.compaction_enabled = true;
    config.temporal_awareness = true;
    config.caveman.enabled = false;
    config.language = None;
    config.prompt_surface_guidance_override = None;
    config
}

/// Every example: its name, request and pinned answer bytes.
fn examples() -> Vec<(String, Value, Vec<u8>)> {
    let mut names: Vec<String> = std::fs::read_dir(examples_dir())
        .unwrap()
        .filter_map(|entry| {
            let name = entry.unwrap().file_name().into_string().unwrap();
            name.strip_suffix(".request.json").map(str::to_string)
        })
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let dir = examples_dir();
            let request: Value = serde_json::from_str(
                &std::fs::read_to_string(dir.join(format!("{name}.request.json"))).unwrap(),
            )
            .unwrap();
            let answer = std::fs::read(dir.join(format!("{name}.answer.jcs"))).unwrap();
            (name, request, answer)
        })
        .collect()
}

#[test]
fn every_example_request_gets_exactly_the_pinned_answer_bytes() {
    let config = example_catalog_config();
    let examples = examples();
    assert_eq!(examples.len(), 12, "the fixture pins twelve examples");
    for (name, request, expected) in examples {
        let actual = tool_catalog::catalog_answer_bytes(&request, &config)
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert!(
            actual == expected,
            "{name}: served\n{}\npinned\n{}",
            String::from_utf8_lossy(&actual),
            String::from_utf8_lossy(&expected)
        );
    }
}

#[test]
fn disabled_smart_notes_catalog_has_no_authoring_or_guidance_on_either_surface() {
    let mut config = example_catalog_config();
    config.smart_notes_enabled = false;
    for surface in ["full", "light"] {
        for compacting in [false, true] {
            let answer =
                tool_catalog::catalog_answer(&role_request("head", compacting, surface), &config)
                    .unwrap();
            let note = answer["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["name"] == "ctx_note")
                .unwrap();
            assert!(note["input_schema"]["properties"]
                .get("surface_condition")
                .is_none());
            let text = format!("{} {}", note, answer["system_text"]["text"]);
            assert!(!text.contains("surface_condition"), "{text}");
            assert!(!text.contains("smart note"), "{text}");
            assert!(!text.contains("outside checker"), "{text}");
        }
    }
    config.guidance_override = Some("Custom guidance\n### Smart notes\n#### Verification\nUse an external condition to park work.\n### Ordinary notes\nKeep intentions in ctx_note.".to_string());
    let answer =
        tool_catalog::catalog_answer(&role_request("head", true, "full"), &config).unwrap();
    let text = answer["system_text"]["text"].as_str().unwrap();
    assert!(!text.contains("external condition"));
    assert!(text.contains("Keep intentions in ctx_note"));
}

#[test]
fn system_text_tool_names_match_served_tools_for_every_example_and_preset() {
    let config = example_catalog_config();
    let check = |name: &str, request: &Value| {
        let answer = tool_catalog::catalog_answer(request, &config).unwrap();
        if let Some(text) = answer.get("system_text") {
            let names: std::collections::BTreeSet<&str> = answer["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tool| tool["name"].as_str().unwrap())
                .collect();
            assert_eq!(text["tool_names"], json!(names), "{name}");
        }
    };
    for (name, request, _) in examples() {
        check(&name, &request);
    }
    for preset in ["head", "worker", "reader"] {
        for surface in ["full", "light"] {
            check(
                &format!("{preset}/{surface}"),
                &json!({"preset": preset, "params": {"tool_descs": if surface == "light" { "concise" } else { "full" }},
                    "system_text": {"preset": preset, "params": {"surface": surface}}}),
            );
        }
    }
}

#[test]
fn tools_only_serves_exactly_the_three_guidance_tools_on_both_surfaces() {
    for surface in ["full", "light"] {
        let answer = tool_catalog::catalog_answer(
            &json!({"preset": "tools-only", "params": {"tool_descs": if surface == "light" { "concise" } else { "full" }},
                "system_text": {"preset": "tools-only", "params": {"surface": surface}}}),
            &example_catalog_config(),
        ).unwrap();
        assert_eq!(
            answer["system_text"]["tool_names"],
            json!(["ctx_memory", "ctx_note", "ctx_search"])
        );
        assert_eq!(answer["tools"].as_array().unwrap().len(), 3);
    }
}

/// Independent expected names: do not derive the contract from preset_tools.
fn role_request(preset: &str, compacting: bool, surface: &str) -> Value {
    let names = match (preset, compacting) {
        ("head", true) => vec![
            "ctx_reduce",
            "ctx_expand",
            "ctx_note",
            "ctx_memory",
            "ctx_search",
        ],
        ("head", false) => vec!["ctx_note", "ctx_memory", "ctx_search"],
        (_, true) => vec!["ctx_reduce", "ctx_expand", "ctx_search"],
        (_, false) => vec![],
    };
    let mut composition = json!({"providers": [{"provider": "magic-context", "tools": names.iter().map(|name| json!({"name": name})).collect::<Vec<_>>()}]});
    if compacting {
        composition["compaction"] = json!({"provider": "magic-context"});
    }
    json!({"preset": preset, "params": {"tool_descs": if surface == "light" { "concise" } else { "full" }},
        "composition": composition, "system_text": {"preset": preset, "params": {"surface": surface}}})
}

#[test]
fn every_role_and_compaction_cell_serves_its_exact_tools_and_text() {
    let config = example_catalog_config();
    for preset in ["head", "worker", "reader"] {
        for compacting in [false, true] {
            for surface in ["full", "light"] {
                let request = role_request(preset, compacting, surface);
                let answer = tool_catalog::catalog_answer(&request, &config).unwrap();
                let expected = match (preset, compacting) {
                    ("head", true) => vec![
                        "ctx_reduce",
                        "ctx_expand",
                        "ctx_note",
                        "ctx_memory",
                        "ctx_search",
                    ],
                    ("head", false) => vec!["ctx_note", "ctx_memory", "ctx_search"],
                    (_, true) => vec!["ctx_reduce", "ctx_expand", "ctx_search"],
                    (_, false) => vec![],
                };
                let names: Vec<&str> = answer["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|tool| tool["name"].as_str().unwrap())
                    .collect();
                assert_eq!(
                    names, expected,
                    "{preset} compacting={compacting} {surface}"
                );
                let text = answer["system_text"]["text"].as_str().unwrap();
                let variant = match (preset, compacting) {
                    ("head", true) => Some(format!("primary/reduce/{surface}")),
                    ("head", false) => Some(format!("tools_only/{surface}")),
                    (_, true) => Some(format!("subagent/{surface}")),
                    (_, false) => None,
                };
                let expected_text = variant
                    .map(|name| {
                        tool_catalog::render_text(
                            &name,
                            &TextFlags {
                                memory: preset == "head",
                                dreamer: true,
                                temporal: true,
                                ..TextFlags::default()
                            },
                            &BTreeMap::from([("language_directive", String::new())]),
                        )
                        .unwrap()
                    })
                    .unwrap_or_default();
                assert_eq!(text, expected_text);
                if !compacting {
                    assert!(!text.contains("ctx_reduce") && !text.contains("ctx_expand"));
                }
                if preset != "head" {
                    assert!(!text.contains("ctx_note") && !text.contains("ctx_memory"));
                }
                // A different provider has exactly the missing-compaction behavior.
                if !compacting {
                    let mut other = request.clone();
                    other["composition"]["compaction"] = json!({"provider": "other-module"});
                    let other = tool_catalog::catalog_answer(&other, &config).unwrap();
                    assert_eq!(other["tools"], answer["tools"]);
                    assert_eq!(other["system_text"]["text"], answer["system_text"]["text"]);
                }
            }
        }
    }
}

#[test]
fn presetless_catalog_lists_exactly_the_three_served_presets() {
    let config = example_catalog_config();
    let answer = tool_catalog::catalog_answer(&json!({}), &config).unwrap();
    assert_eq!(answer["presets"], json!(["head", "worker", "reader"]));
    for compacting in [false, true] {
        for surface in ["light", "full"] {
            let mut request = role_request("head", compacting, surface);
            request.as_object_mut().unwrap().remove("preset");
            let answer = tool_catalog::catalog_answer(&request, &config).unwrap();
            assert_eq!(answer["presets"], json!(["head", "worker", "reader"]));

            let mut content = answer.as_object().unwrap().clone();
            let digest = content.remove("catalog_digest").unwrap();
            assert_eq!(content.remove("generation").unwrap(), digest);
            assert_eq!(
                digest,
                json!(sha256_hex(&serde_jcs::to_vec(&content).unwrap()))
            );

            request["digest_only"] = json!(true);
            let digest_only = tool_catalog::catalog_answer(&request, &config).unwrap();
            assert_eq!(
                digest_only,
                json!({"generation": digest, "catalog_digest": digest})
            );
        }
    }
}

#[test]
fn preset_catalogs_do_not_list_presets() {
    let config = example_catalog_config();
    for preset in [
        "head",
        "worker",
        "reader",
        "primary",
        "subagent",
        "tools-only",
    ] {
        let role = match preset {
            "primary" | "tools-only" => "head",
            "subagent" => "worker",
            other => other,
        };
        for compacting in [false, true] {
            for surface in ["light", "full"] {
                let mut request = role_request(role, compacting, surface);
                request["preset"] = json!(preset);
                let answer = tool_catalog::catalog_answer(&request, &config).unwrap();
                assert!(answer.get("presets").is_none(), "{preset}");
            }
        }
    }
}

#[test]
fn user_commands_are_declared_only_for_compacting_head_catalogs() {
    let config = example_catalog_config();
    for preset in ["head", "worker", "reader"] {
        for compacting in [false, true] {
            let answer =
                tool_catalog::catalog_answer(&role_request(preset, compacting, "full"), &config)
                    .unwrap();
            let commands = answer
                .get("user_commands")
                .and_then(Value::as_array)
                .map(|commands| {
                    commands
                        .iter()
                        .map(|command| command["name"].as_str().unwrap())
                        .collect::<Vec<_>>()
                });
            if preset == "head" && compacting {
                assert_eq!(
                    commands,
                    Some(vec!["ctx-status", "ctx-flush", "ctx-wrapup"])
                );
            } else {
                assert!(commands.is_none(), "{preset} compacting={compacting}");
            }
        }
    }
}

#[test]
fn compacting_preflight_param_returns_tools_and_text_for_the_composed_request() {
    let config = example_catalog_config();
    let request = json!({
        "preset": "head",
        "params": {
            "compacting": true,
            "model": "anthropic/claude-haiku-4-5"
        },
        "system_text": {
            "preset": "head",
            "params": {
                "compacting": true,
                "model": "anthropic/claude-haiku-4-5"
            }
        }
    });
    let preflight = tool_catalog::catalog_answer(&request, &config).unwrap();
    let names: Vec<&str> = preflight["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "ctx_reduce",
            "ctx_expand",
            "ctx_note",
            "ctx_memory",
            "ctx_search"
        ]
    );
    assert!(preflight.get("composition_digest").is_none());
    assert!(preflight["system_text"].get("composition_digest").is_none());

    let mut different_text_mode = request.clone();
    different_text_mode["system_text"]["params"]["compacting"] = json!(false);
    let different_text_answer =
        tool_catalog::catalog_answer(&different_text_mode, &config).unwrap();
    assert_ne!(
        preflight["system_text"]["preflight_digest"],
        different_text_answer["system_text"]["preflight_digest"]
    );

    let tools: Vec<Value> = preflight["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| json!({"name": tool["name"]}))
        .collect();
    let mut composed_request = request.clone();
    composed_request["composition"] = json!({
        "compaction": {"provider": "magic-context"},
        "providers": [{"provider": "magic-context", "tools": tools}]
    });
    let composed = tool_catalog::catalog_answer(&composed_request, &config).unwrap();
    assert_eq!(
        preflight["system_text"]["text"]
            .as_str()
            .unwrap()
            .as_bytes(),
        composed["system_text"]["text"].as_str().unwrap().as_bytes()
    );
}

#[test]
fn plain_preflight_answer_bytes_stay_pinned() {
    let request = json!({"preset": "head", "params": {}});
    let expected = std::fs::read(examples_dir().join("preflight.answer.jcs")).unwrap();
    let actual = tool_catalog::catalog_answer_bytes(&request, &example_catalog_config()).unwrap();
    assert_eq!(actual, expected);
    let answer: Value = serde_json::from_slice(&actual).unwrap();
    assert_eq!(answer["catalog_digest"], answer["generation"]);
}

#[test]
fn aliases_resolve_from_one_table_without_selecting_compaction() {
    for (alias, role) in [
        ("primary", "head"),
        ("subagent", "worker"),
        ("tools-only", "head"),
    ] {
        for compacting in [false, true] {
            let request = role_request(role, compacting, "full");
            let expected =
                tool_catalog::catalog_answer(&request, &example_catalog_config()).unwrap();
            let mut aliased = request.clone();
            aliased["preset"] = json!(alias);
            assert_eq!(
                tool_catalog::catalog_answer(&aliased, &example_catalog_config()).unwrap(),
                expected
            );
            aliased["system_text"]["preset"] = json!(alias);
            let actual = tool_catalog::catalog_answer(&aliased, &example_catalog_config()).unwrap();
            assert_eq!(actual["tools"], expected["tools"]);
            assert_eq!(
                actual["system_text"]["text"],
                expected["system_text"]["text"]
            );
        }
    }
}

#[test]
fn unknown_tool_and_text_presets_are_unserved_by_name() {
    for name in ["mason", "HEAD", "", "toString"] {
        for arguments in [
            json!({"params": {}, "preset": name}),
            json!({"params": {}, "preset": "head", "system_text": {"preset": name, "params": {}}}),
        ] {
            assert_eq!(
                tool_catalog::catalog_answer(&arguments, &example_catalog_config()).unwrap_err(),
                CatalogError::Invalid {
                    field: "preset".to_string(),
                    message: format!("Magic Context defines no preset {name:?}")
                }
            );
        }
    }
}

#[test]
fn compaction_must_be_an_object_with_a_provider_and_never_null() {
    for compaction in [
        Value::Null,
        json!({}),
        json!({"provider": ""}),
        json!({"provider": 42}),
        json!([]),
        json!("magic-context"),
    ] {
        let request = json!({"params": {}, "composition": {"compaction": compaction}});
        assert!(
            matches!(tool_catalog::catalog_answer(&request, &example_catalog_config()), Err(CatalogError::Invalid { field, .. }) if field == "composition.compaction")
        );
    }
}

#[test]
fn role_describe_advertises_compacting_preflight() {
    let answer: Value =
        serde_json::from_slice(&tool_catalog::role_describe_bytes().unwrap()).unwrap();
    assert_eq!(answer["capabilities"], json!(["compacting-preflight/v1"]));
}

#[test]
fn the_example_settings_resolve_to_the_example_config_member_for_member() {
    assert_eq!(
        CatalogConfig::from_module_config(&example_module_config()),
        example_catalog_config()
    );
}

#[test]
fn text_revision_is_the_one_config_json_records() {
    assert_eq!(
        json!(tool_catalog::text_revision().unwrap()),
        example_config_json()["text_revision"]
    );
}

#[test]
fn every_guidance_text_matches_the_generators_matrix() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata/tool-catalog-guidance-matrix.json");
    let matrix: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let override_sample = matrix["override_sample"].as_str().unwrap().to_string();
    let cases = matrix["cases"].as_array().unwrap();
    // Legacy plugin variants and catalog role variants, on both surfaces.
    assert_eq!(cases.len(), 8 * 2 * 16 * 2);
    for case in cases {
        let directive = case["language"]
            .as_str()
            .and_then(crate::primary_language_directive);
        let flags = TextFlags {
            memory: case["memory"].as_bool().unwrap(),
            dreamer: case["dreamer"].as_bool().unwrap(),
            temporal: case["temporal"].as_bool().unwrap(),
            caveman: case["caveman"].as_bool().unwrap(),
            language: directive.is_some(),
        };
        let mut values = BTreeMap::new();
        values.insert("language_directive", directive.unwrap_or_default());
        let name = if case["override"].as_bool().unwrap() {
            values.insert("override", override_sample.clone());
            "override".to_string()
        } else {
            format!(
                "{}/{}",
                case["variant"].as_str().unwrap(),
                case["surface"].as_str().unwrap()
            )
        };
        let text = tool_catalog::render_text(&name, &flags, &values).unwrap();
        assert_eq!(
            (text.len() as u64, sha256_hex(text.as_bytes())),
            (
                case["bytes"].as_u64().unwrap(),
                case["sha256"].as_str().unwrap().to_string()
            ),
            "{case}"
        );
    }
}

#[test]
fn the_guidance_get_assets_are_renderings_of_the_shared_definition() {
    // guidance.get still serves these files; the catalog serves the definition.
    // Holding them equal keeps the two surfaces from drifting apart.
    let flags = TextFlags {
        memory: true,
        dreamer: true,
        temporal: true,
        caveman: false,
        language: false,
    };
    let values = BTreeMap::from([("language_directive", String::new())]);
    for (asset, text) in [
        (
            crate::prompt_surface::GUIDANCE_FULL_PRIMARY,
            "primary/reduce/full",
        ),
        (
            crate::prompt_surface::GUIDANCE_FULL_NO_REDUCE,
            "primary/no_reduce/full",
        ),
        (
            include_str!("../../assets/guidance_light_primary.txt"),
            "primary/reduce/light",
        ),
        (
            include_str!("../../assets/guidance_light_no_reduce.txt"),
            "primary/no_reduce/light",
        ),
    ] {
        assert_eq!(
            tool_catalog::render_text(text, &flags, &values).unwrap(),
            asset,
            "{text}"
        );
    }
}

#[test]
fn every_capability_tag_passes_the_roles_check() {
    let mut tags: Vec<String> = tool_catalog::definition()
        .tools
        .iter()
        .flat_map(|tool| tool.capabilities.clone())
        .collect();
    fn collect(value: &Value, tags: &mut Vec<String>) {
        match value {
            Value::Array(items) => items.iter().for_each(|item| collect(item, tags)),
            Value::Object(map) => {
                for (key, item) in map {
                    match (key.as_str(), item) {
                        ("capabilities", Value::Array(found)) => {
                            tags.extend(found.iter().filter_map(Value::as_str).map(str::to_string))
                        }
                        _ => collect(item, tags),
                    }
                }
            }
            _ => {}
        }
    }
    for (_, request, answer) in examples() {
        collect(&request, &mut tags);
        collect(&serde_json::from_slice(&answer).unwrap(), &mut tags);
    }
    tags.sort();
    tags.dedup();
    assert_eq!(tags.len(), 14, "{tags:?}");
    for tag in &tags {
        assert_eq!(check_capability_tag(tag), Ok(()), "{tag}");
    }
}

#[test]
fn ctx_reduce_keeps_its_frozen_schema_at_both_surfaces() {
    let definition = tool_catalog::definition();
    let reduce = definition
        .tools
        .iter()
        .find(|tool| tool.name == "ctx_reduce")
        .unwrap();
    for surface in [Surface::Full, Surface::Light] {
        let schema = tool_catalog::input_schema(reduce, surface).unwrap();
        assert_eq!(
            cortexkit_role_tool_provider::catalog::schema_digest(&schema).unwrap(),
            tool_catalog::FROZEN_CTX_REDUCE_SCHEMA_DIGEST
        );
        assert_eq!(
            cortexkit_role_tool_provider::catalog::check_flat_schema(&schema),
            Ok(())
        );
    }
}

#[test]
fn model_keys_are_searched_in_the_plugins_order() {
    assert_eq!(
        tool_catalog::model_key_candidates("anthropic/claude-haiku-4-5"),
        [
            "anthropic/claude-haiku-4-5",
            "claude-haiku-4-5",
            "anthropic/claude-haiku-4",
            "claude-haiku-4",
            "anthropic/claude-haiku",
            "claude-haiku",
            "anthropic/claude",
            "claude",
            "anthropic/*",
        ]
    );
    // A Pi-native provider is searched canonical-first, then as sent, then in
    // OMP's spelling, which here is the same as Pi's.
    assert_eq!(
        tool_catalog::model_key_candidates("openai-codex/gpt-5"),
        [
            "openai/gpt-5",
            "openai-codex/gpt-5",
            "gpt-5",
            "openai/gpt",
            "openai-codex/gpt",
            "gpt",
            "openai/*",
            "openai-codex/*",
        ]
    );
    for malformed in ["no-slash", "/model", "provider/"] {
        assert!(tool_catalog::model_key_candidates(malformed).is_empty());
    }
}

#[test]
fn refusals_name_the_offending_field() {
    let config = example_catalog_config();
    for (arguments, field) in [
        (
            json!({"params": {}, "preset": "primary", "system_text": {"preset": "subagent", "params": {}}}),
            "system_text.preset",
        ),
        (json!({"params": {"verbosity": "high"}}), "params.verbosity"),
        (json!({"params": {"scope": "everything"}}), "params.scope"),
        (
            json!({"params": {"compacting": "yes"}}),
            "params.compacting",
        ),
        (
            json!({"params": {}, "system_text": {"preset": "head", "params": {"compacting": 1}}}),
            "system_text.params.compacting",
        ),
        (
            json!({"params": {"compacting": false}, "composition": {"compaction": {"provider": "magic-context"}}}),
            "params.compacting",
        ),
        (
            json!({"params": {}, "composition": {"compaction": {"provider": "magic-context"}}, "system_text": {"preset": "head", "params": {"compacting": false}}}),
            "params.compacting",
        ),
        (
            json!({"params": {"exclude": ["ctx_memory_list"]}}),
            "params.exclude",
        ),
        (
            json!({"params": {}, "system_text": {"preset": "primary", "params": {"surface": "tiny"}}}),
            "system_text.params.surface",
        ),
        (
            // tools-only never serves ctx_reduce, so a composition listing it
            // describes a session this answer cannot serve.
            json!({"params": {}, "preset": "tools-only", "composition": {"providers": [{
                "provider": "magic-context",
                "tools": [{"name": "ctx_expand"}, {"name": "ctx_memory"}, {"name": "ctx_note"},
                          {"name": "ctx_reduce"}, {"name": "ctx_search"}],
            }]}}),
            "composition",
        ),
        (
            // No shipped text describes a session without ctx_note.
            json!({"params": {"scope": "read"}, "system_text": {"preset": "primary", "params": {}}}),
            "system_text",
        ),
        (json!("not an object"), "arguments"),
    ] {
        match tool_catalog::catalog_answer(&arguments, &config) {
            Err(CatalogError::Invalid { field: actual, .. }) => {
                assert_eq!(actual, field, "{arguments}")
            }
            other => panic!("{arguments}: expected a refusal naming {field}, got {other:?}"),
        }
    }
}

#[test]
fn a_user_override_replaces_head_text_with_or_without_compaction() {
    let mut config = example_catalog_config();
    config.guidance_override = Some("My own section.".to_string());
    let text_for = |preset: &str, compacting: bool, config: &CatalogConfig| {
        let mut request = json!({"params": {}, "preset": preset, "system_text": {"preset": preset, "params": {}}});
        if compacting {
            let names = if preset == "head" {
                vec![
                    "ctx_reduce",
                    "ctx_expand",
                    "ctx_note",
                    "ctx_memory",
                    "ctx_search",
                ]
            } else {
                vec!["ctx_reduce", "ctx_expand", "ctx_search"]
            };
            request["composition"] = json!({"compaction": {"provider": "magic-context"}, "providers": [{"provider": "magic-context", "tools": names.iter().map(|name| json!({"name": name})).collect::<Vec<_>>()}]});
        }
        let answer = tool_catalog::catalog_answer(&request, config).unwrap();
        answer["system_text"]["text"].as_str().unwrap().to_string()
    };
    let primary = text_for("head", true, &config);
    assert!(primary.starts_with("My own section."), "{primary}");
    // The config-driven clauses (here the temporal-marker line) still follow
    // the user's section.
    assert!(primary.contains("<!-- +Xm -->"), "{primary}");
    // Primary prose is user-owned with or without compaction; bounded children ignore it.
    let plain = example_catalog_config();
    assert!(text_for("head", false, &config).starts_with("My own section."));
    assert_eq!(
        text_for("worker", true, &config),
        text_for("worker", true, &plain)
    );
    // The override changes only answers that carry a text item: without one
    // there is no preflight_digest, so the catalog digest stays the same.
    let digest = |config: &CatalogConfig| {
        tool_catalog::catalog_answer(&json!({"params": {}}), config).unwrap()["catalog_digest"]
            .clone()
    };
    assert_eq!(
        digest(&config),
        digest(&plain),
        "no text item, so no preflight digest"
    );
}

/// The handler a dispatch test drives: the example config, bound on channel 7.
fn example_handler() -> (McHandler, Arc<McStore>, tempfile::TempDir, PathBuf) {
    let (handler, store, dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), example_module_config());
    handler.bind_route(
        7,
        SessionBinding {
            config: example_module_config(),
            ..binding(project.to_str().unwrap(), "ses")
        },
    );
    (handler, store, dir, project)
}

#[tokio::test(flavor = "current_thread")]
async fn tool_catalog_over_the_route_serves_the_pinned_bytes() {
    let (handler, _store, _dir, _project) = example_handler();
    for (name, request, expected) in examples() {
        let outcome = handler
            .dispatch_value(7, json!({"name": "tool.catalog", "arguments": request}))
            .await;
        match outcome {
            HandlerOutcome::Response(bytes) => assert!(bytes == expected, "{name}"),
            other => panic!("{name}: {other:?}"),
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn an_undefined_preset_is_refused_with_the_roles_error_body() {
    let (handler, _store, _dir, _project) = example_handler();
    let outcome = handler
        .dispatch_value(
            7,
            json!({"name": "tool.catalog", "arguments": {"params": {}, "preset": "mason"}}),
        )
        .await;
    match outcome {
        HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
            assert_eq!(code, "invalid_request");
            assert_eq!(detail, json!({"field": "preset"}));
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn calls_use_the_frozen_session_catalog_not_caller_compaction_claims() {
    let (handler, _store, _dir, project) = example_handler();
    let refuse = |outcome: HandlerOutcome, tool: &str| match outcome {
        HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
            assert_eq!(code, "unknown_tool");
            assert_eq!(detail, json!({"tool": tool}));
        }
        other => panic!("{other:?}"),
    };
    let reduce = json!({"name": "ctx_reduce", "preset": "head", "arguments": {"tags": "1"}, "composition": {"compaction": {"provider": "magic-context"}}});
    refuse(
        handler.dispatch_value(7, reduce.clone()).await,
        "ctx_reduce",
    );
    let catalog = role_request("head", false, "full");
    assert!(matches!(
        handler
            .dispatch_value(7, json!({"name": "tool.catalog", "arguments": catalog}))
            .await,
        HandlerOutcome::Response(_)
    ));
    // A fetched catalog still gates a call whose preset was omitted.
    refuse(
        handler
            .dispatch_value(7, json!({"name": "ctx_reduce", "arguments": {"drop": "1"}}))
            .await,
        "ctx_reduce",
    );
    // A second route for this session sees the same catalog.
    handler.bind_route(
        8,
        SessionBinding {
            config: example_module_config(),
            ..binding(project.to_str().unwrap(), "ses")
        },
    );
    refuse(
        handler.dispatch_value(8, reduce.clone()).await,
        "ctx_reduce",
    );
    // Preflight, failed fetches and digest probes do not change the admitted plan.
    for request in [
        json!({"preset": "head", "params": {}}),
        {
            let mut request = role_request("head", true, "full");
            request["digest_only"] = json!(true);
            request
        },
        json!({"preset": "head", "params": {}, "composition": {"compaction": {"provider": "magic-context"}, "providers": []}}),
    ] {
        handler
            .dispatch_value(8, json!({"name": "tool.catalog", "arguments": request}))
            .await;
        refuse(
            handler.dispatch_value(7, reduce.clone()).await,
            "ctx_reduce",
        );
    }
    let compacting = role_request("worker", true, "full");
    assert!(matches!(
        handler
            .dispatch_value(8, json!({"name": "tool.catalog", "arguments": compacting}))
            .await,
        HandlerOutcome::Response(_)
    ));
    assert!(handler.check_catalog_call(7, "ctx_reduce", &reduce).is_ok());
    for preset in [
        "head",
        "worker",
        "reader",
        "primary",
        "subagent",
        "tools-only",
    ] {
        for tool in ["ctx_note", "ctx_memory"] {
            refuse(handler.dispatch_value(7, json!({"name": tool, "preset": preset, "arguments": {"action": "write", "content": "forbidden"}})).await, tool);
        }
    }
    match handler
        .dispatch_value(
            7,
            json!({"name": "ctx_reduce", "preset": "mason", "arguments": {"tags": "1"}}),
        )
        .await
    {
        HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
            assert_eq!(code, "invalid_request");
            assert_eq!(detail, json!({"field": "preset"}));
        }
        other => panic!("{other:?}"),
    }
    // A new session on a recycled channel has no inherited compaction grant.
    handler.bind_route(
        8,
        SessionBinding {
            config: example_module_config(),
            ..binding(project.to_str().unwrap(), "other-session")
        },
    );
    refuse(handler.dispatch_value(8, reduce).await, "ctx_reduce");
}

#[tokio::test(flavor = "current_thread")]
async fn reconnect_after_restart_refetches_catalog_or_uses_planless_legacy_dispatch() {
    let resolver = FakeSessionResolver::with(&[("ses", FakeResolve::Hit("ses".to_string()))]);
    let (first_handler, store, _dir, project) = handler_with_store_and_resolver(
        Arc::new(ProducerState::default()),
        example_module_config(),
        resolver.clone(),
    );
    first_handler.bind_route(
        7,
        SessionBinding {
            config: example_module_config(),
            ..binding_with_harness(project.to_str().unwrap(), "claude-code", "ses")
        },
    );
    let role_versions = BTreeMap::from([("tool-provider".to_string(), "v1".to_string())]);
    first_handler.record_route_role_versions(7, Some(&role_versions));

    let catalog_request = role_request("head", true, "full");
    let first_catalog = first_handler
        .dispatch_value(
            7,
            json!({"name": "tool.catalog", "arguments": catalog_request.clone()}),
        )
        .await;
    let first_catalog = tool_body(first_catalog);
    assert!(first_catalog["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["name"] == "ctx_reduce"));
    assert_eq!(first_handler.frozen_tool_catalogs.lock().unwrap().len(), 1);
    drop(first_handler);

    // A new handler is a new ck-mc process: the store survives, but the
    // process-local frozen role catalog does not.
    let restarted = McHandler::with_producer_factory_config_resolver(
        Arc::new(TestProducerFactory {
            state: Arc::new(ProducerState::default()),
        }),
        example_module_config(),
        resolver,
    );
    restarted.store.set(Arc::clone(&store)).ok().unwrap();
    restarted.bind_route(
        7,
        SessionBinding {
            config: example_module_config(),
            ..binding_with_harness(project.to_str().unwrap(), "claude-code", "ses")
        },
    );
    restarted.record_route_role_versions(7, Some(&role_versions));
    assert!(restarted.frozen_tool_catalogs.lock().unwrap().is_empty());

    store
        .seed_tags_for_test(
            "ses",
            &[TagMintInput {
                block_id: "reconnect-target".to_string(),
                kind: "message".to_string(),
                token_count: 1,
                source_bytes: b"reconnect target".to_vec(),
            }],
            1,
        )
        .unwrap();

    // The Claude Code/subc-mcp compatibility path omits the preset when no
    // frozen catalog is available, retaining the legacy facade dispatch.
    let legacy = restarted
        .dispatch_value(7, json!({"name": "ctx_reduce", "arguments": {"drop": "1"}}))
        .await;
    assert!(!tool_is_error(legacy));

    // A role-aware reconnect restores the compacting head grant by fetching the
    // full composition again before sending a preset-bearing call.
    let catalog = restarted
        .dispatch_value(
            7,
            json!({"name": "tool.catalog", "arguments": catalog_request}),
        )
        .await;
    let catalog = tool_body(catalog);
    assert!(catalog["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["name"] == "ctx_reduce"));
    let compacting_head_call = restarted
        .dispatch_value(
            7,
            json!({
                "name": "ctx_reduce",
                "preset": "head",
                "arguments": {"drop": "1"},
                "composition": {"compaction": {"provider": "magic-context"}}
            }),
        )
        .await;
    assert!(!tool_is_error(compacting_head_call));
}

#[tokio::test(flavor = "current_thread")]
async fn shared_head_catalog_refuses_helper_writes_without_mutating_store_and_allows_head() {
    for compacting in [false, true] {
        let resolver = FakeSessionResolver::with(&[("ses", FakeResolve::Hit("ses".to_string()))]);
        let (handler, store, _dir, project) = handler_with_store_and_resolver(
            Arc::new(ProducerState::default()),
            example_module_config(),
            resolver,
        );
        let root = project.to_str().unwrap();
        handler.bind_route(
            7,
            SessionBinding {
                config: example_module_config(),
                ..binding(root, "ses")
            },
        );
        let catalog = role_request("head", compacting, "full");
        assert!(matches!(
            handler
                .dispatch_value(7, json!({"name": "tool.catalog", "arguments": catalog}))
                .await,
            HandlerOutcome::Response(_)
        ));
        // Claude Code exposes the head's list to subagents too. Admission must
        // still use each call's role, not merely the session's visible tools.
        for preset in ["worker", "reader"] {
            for tool in ["ctx_memory", "ctx_note"] {
                let outcome = handler.dispatch_value(7, json!({"name": tool, "preset": preset,
                    "arguments": {"action": "write", "content": "must not be written", "category": "CONSTRAINTS"}})).await;
                match outcome {
                    HandlerOutcome::ErrorWithDetail {
                        code,
                        message,
                        detail,
                    } => {
                        assert_eq!(code, "unknown_tool");
                        assert_eq!(message, format!("no tool named {tool}"));
                        assert_eq!(detail, json!({"tool": tool}));
                    }
                    other => panic!("{preset}/{tool}: {other:?}"),
                }
                assert!(store
                    .load_active_memories(root, now_ms())
                    .unwrap()
                    .is_empty());
                assert!(store.read_notes(root, "ses", 100, 0).unwrap().is_empty());
            }
        }
        for tool in ["ctx_memory", "ctx_note"] {
            let outcome = handler.dispatch_value(7, json!({"name": tool, "preset": "head",
                "arguments": {"action": "write", "content": "head may write", "category": "CONSTRAINTS"}})).await;
            assert!(!tool_is_error(outcome), "head/{tool}");
        }
        assert_eq!(store.load_active_memories(root, now_ms()).unwrap().len(), 1);
        assert_eq!(store.read_notes(root, "ses", 100, 0).unwrap().len(), 1);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn role_describe_lists_the_required_ops_and_no_tools() {
    let (handler, _store, _dir, _project) = example_handler();
    let first = handler
        .dispatch_value(7, json!({"name": "role.describe", "arguments": {}}))
        .await;
    let HandlerOutcome::Response(bytes) = first else {
        panic!("{first:?}");
    };
    let answer: Value = serde_json::from_slice(&bytes).unwrap();
    let describe = cortexkit_role_tool_provider::describe::check_describe(&answer).unwrap();
    let major = describe
        .major(cortexkit_role_tool_provider::PROVIDES)
        .unwrap();
    assert!(!major.holds_calls());
    assert_eq!(describe.implementation_version, crate::version_line());
}

#[tokio::test(flavor = "current_thread")]
async fn only_a_route_that_declared_the_role_gets_unknown_tool() {
    let (handler, _store, _dir, _project) = example_handler();
    let unserved = json!({"name": "not_a_tool", "arguments": {}});
    // A legacy route keeps the error code it has always had.
    assert_eq!(
        error_code(handler.dispatch_value(7, unserved.clone()).await),
        "facade_envelope_not_supported"
    );
    handler.record_route_role_versions(
        7,
        Some(&BTreeMap::from([(
            "tool-provider".to_string(),
            "v1".to_string(),
        )])),
    );
    match handler.dispatch_value(7, unserved.clone()).await {
        HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
            assert_eq!(code, "unknown_tool");
            assert_eq!(detail, json!({"tool": "not_a_tool"}));
        }
        other => panic!("{other:?}"),
    }
    // A rebind without the tool-provider/v1 declaration drops the role's codes.
    handler.record_route_role_versions(7, None);
    assert_eq!(
        error_code(handler.dispatch_value(7, unserved).await),
        "facade_envelope_not_supported"
    );
}

/// A Claude Code subagent conversation (`<session_id>/<agent_id>`) fetches its
/// guidance with `{"preset":"worker","params":{"model":"<provider>/<model>"}}`.
/// Its `system_text` is byte-identical to the guidance standalone OpenCode
/// injects into a subagent for the same model: the generator's matrix records
/// that text as the `subagent` variant, rendered by the plugin's own
/// `buildMagicContextSection(..., subagentMode)`, for the surface the model
/// resolves to. OpenCode's subagent text ignores the memory, smart-notes,
/// temporal, caveman and language settings, and the matrix shows the same
/// digest for every combination of them. `reader` serves the same text.
#[test]
fn worker_system_text_is_standalone_opencode_subagent_guidance_for_the_model() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata/tool-catalog-guidance-matrix.json");
    let matrix: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let opencode_subagent = |surface: &str| {
        let digests: std::collections::BTreeSet<(u64, String)> = matrix["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|case| {
                case["variant"] == "subagent"
                    && case["surface"] == surface
                    && case["override"] == false
            })
            .map(|case| {
                (
                    case["bytes"].as_u64().unwrap(),
                    case["sha256"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert_eq!(digests.len(), 1, "subagent/{surface} depends on a flag");
        digests.into_iter().next().unwrap()
    };
    let template: Value = serde_json::from_str(
        &std::fs::read_to_string(examples_dir().join("worker.request.json")).unwrap(),
    )
    .unwrap();
    let config = example_catalog_config();
    // The example config serves claude-haiku-4-5 the light surface.
    for (model, surface) in [
        ("anthropic/claude-sonnet-4-5", "full"),
        ("anthropic/claude-haiku-4-5", "light"),
    ] {
        for preset in ["worker", "reader"] {
            let mut request = template.clone();
            request["preset"] = json!(preset);
            request["params"] = json!({"model": model});
            request["system_text"] = json!({"preset": preset, "params": {"model": model}});
            let answer: Value = serde_json::from_slice(
                &tool_catalog::catalog_answer_bytes(&request, &config).unwrap(),
            )
            .unwrap();
            let text = answer["system_text"]["text"].as_str().unwrap();
            assert_eq!(
                (text.len() as u64, sha256_hex(text.as_bytes())),
                opencode_subagent(surface),
                "{preset} {model}"
            );
        }
    }
}
