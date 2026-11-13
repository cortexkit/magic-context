//! `tool.catalog` and `role.describe` against pinned payloads.
//!
//! `src/catalog/fixtures/tool-catalog/` holds the exact bytes the module must serve
//! for each example request under `config.json` (prompt surface, tool enablement,
//! and guidance feature flags), and
//! `testdata/tool-catalog-guidance-matrix.json` the digest of every guidance text
//! for every combination of config inputs. Both are written by
//! `crates/mc-module/gen/gen-tool-catalog.ts` from the same shared definition
//! the module serves from, so these tests hold the generator's TypeScript
//! evaluator and cortexkit-persona to the same bytes. Frozen pre-migration
//! templates also keep the byte comparison independent of the current assets.

use std::collections::BTreeMap;
use std::path::PathBuf;

use cortexkit_role_tool_provider::check_capability_tag;

use serde_json::{json, Value};

use super::{self as tool_catalog, CatalogConfig, CatalogError, Surface, TextFlags};

#[test]
fn surface_workers_and_readers_offer_keep_with_string_tags_and_note() {
    for preset in ["worker", "reader"] {
        let answer = tool_catalog::catalog_answer(
            &json!({"preset": preset, "params": {"compacting": true}}),
            &example_catalog_config(),
        )
        .unwrap();
        let keep = answer["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "ctx_keep")
            .expect("ctx_keep must be offered");
        assert_eq!(keep["input_schema"]["properties"]["tags"]["type"], "string");
        assert_eq!(keep["input_schema"]["properties"]["note"]["type"], "string");
        assert_eq!(keep["input_schema"]["required"], json!(["tags", "note"]));
    }
}

/// The reply-language directive the generator's matrix was rendered with:
/// the language's name from the plugin's own table, as the plugin words it.
fn language_directive(language: &str) -> Option<String> {
    let name = crate::content_language::resolve_language_name(Some(language))?;
    Some(format!(
        "Use {name} for your natural-language replies to the user unless the user explicitly asks for another language. Keep code, identifiers, file paths, commands, logs, and quoted text verbatim."
    ))
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

fn examples_dir() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/catalog/fixtures/tool-catalog")
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
        user_commands: true,
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
        (_, true) => vec!["ctx_reduce", "ctx_expand", "ctx_search", "ctx_keep"],
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
                    (_, true) => vec!["ctx_reduce", "ctx_expand", "ctx_search", "ctx_keep"],
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
    assert_eq!(
        answer["capabilities"],
        json!([
            "compacting-preflight/v1",
            subc_protocol::scope::BIND_NO_PROJECT_CAPABILITY,
            subc_protocol::scope::SCOPE_WORKDIR_CAPABILITY,
        ])
    );
}

/// Core admits ck-mc as a plan sender only when `reminder_templates`
/// names every template the sender carries, with that template's digest and
/// a delivery the sends use.
#[test]
fn role_describe_lists_every_reminder_template_with_digest_and_delivery() {
    let answer: Value =
        serde_json::from_slice(&tool_catalog::role_describe_bytes().unwrap()).unwrap();
    let sender: cortexkit_role_llm_runner::delivery_order::PlanSender =
        serde_json::from_value(answer["reminder_templates"]["sender"].clone()).unwrap();
    assert_eq!(sender.module, "magic-context");
    let listed = answer["reminder_templates"]["templates"]
        .as_array()
        .unwrap();
    assert_eq!(listed.len(), sender.templates.len());
    for (template, entry) in sender.templates.iter().zip(listed) {
        assert_eq!(entry["id"], json!(template.id));
        assert_eq!(
            entry["digest"],
            json!(cortexkit_role_llm_runner::delivery_order::template_digest(
                template
            ))
        );
        let expected = if template.id == crate::nudges::KEEP_TEMPLATE
            || template.id.starts_with("mc.ctx_reduce.ceiling.")
        {
            "steer"
        } else {
            "tool_result"
        };
        assert_eq!(
            entry["delivery"],
            json!(["turn_system_cleared", expected]),
            "{}",
            template.id
        );
    }
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
        let directive = case["language"].as_str().and_then(language_directive);
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
fn persona_matches_legacy_bytes_for_every_template_and_switch_combination() {
    for bits in 0..32 {
        let flags = all_flags(bits);
        for override_text in [
            "My own section.",
            "<tag>&\"\r\n{{unknown}} {% if module.memory %}§42§",
        ] {
            let values = BTreeMap::from([
                (
                    "language_directive",
                    "<language>&\r\n{{verbatim}}".to_string(),
                ),
                ("override", override_text.to_string()),
            ]);
            for name in legacy_texts().keys() {
                assert_eq!(
                    tool_catalog::render_text(name, &flags, &values).unwrap(),
                    legacy_render(name, &flags, &values),
                    "{name}, switches={bits}, override={override_text:?}"
                );
            }
        }
    }
}

fn all_flags(bits: u8) -> TextFlags {
    TextFlags {
        memory: bits & 1 != 0,
        dreamer: bits & 2 != 0,
        temporal: bits & 4 != 0,
        caveman: bits & 8 != 0,
        language: bits & 16 != 0,
    }
}

#[test]
fn catalog_runner_fields_match_legacy_for_every_role_and_switch_combination() {
    for smart_notes_enabled in [false, true] {
        for preset in ["head", "worker", "reader"] {
            for compacting in [false, true] {
                for surface in ["full", "light"] {
                    for bits in 0..32 {
                        for reduce in [false, true] {
                            for overridden in [false, true] {
                                let flags = all_flags(bits);
                                let mut config = example_catalog_config();
                                config.smart_notes_enabled = smart_notes_enabled;
                                config.memory_enabled = flags.memory;
                                config.dreamer_runnable = flags.dreamer;
                                config.temporal_awareness = flags.temporal;
                                config.caveman_text_compression = flags.caveman;
                                config.language = flags.language.then(|| "tr".to_string());
                                config.guidance_override =
                                    overridden.then(|| "<own>&\r\n{{literal}}".to_string());
                                let mut request = role_request(preset, compacting, surface);
                                if !reduce {
                                    request["params"]["exclude"] = json!(["ctx_reduce"]);
                                }
                                let tools = request["composition"]["providers"][0]["tools"]
                                    .as_array_mut()
                                    .unwrap();
                                tools.retain(|tool| {
                                    (reduce || tool["name"] != "ctx_reduce")
                                        && (flags.memory || tool["name"] != "ctx_memory")
                                });
                                let expected_names: std::collections::BTreeSet<_> = tools
                                    .iter()
                                    .map(|tool| tool["name"].as_str().unwrap().to_string())
                                    .collect();
                                let answer =
                                    tool_catalog::catalog_answer(&request, &config).unwrap();
                                let name = if preset != "head" {
                                    (compacting && reduce).then(|| format!("worker/{surface}"))
                                } else if overridden {
                                    Some("override".to_string())
                                } else if !compacting {
                                    Some(format!("tools_only/{surface}"))
                                } else {
                                    Some(format!(
                                        "head/{}/{surface}",
                                        if reduce { "reduce" } else { "no_reduce" }
                                    ))
                                };
                                let values = BTreeMap::from([
                                    (
                                        "language_directive",
                                        tool_catalog::primary_language_directive(
                                            config.language.as_deref(),
                                        ),
                                    ),
                                    (
                                        "override",
                                        config.guidance_override.clone().unwrap_or_default(),
                                    ),
                                ]);
                                let expected = name
                                    .map(|name| {
                                        legacy_render(
                                            &name,
                                            &TextFlags {
                                                dreamer: flags.dreamer && smart_notes_enabled,
                                                ..flags
                                            },
                                            &values,
                                        )
                                    })
                                    .unwrap_or_default();
                                let text = &answer["system_text"];
                                assert_eq!(text["text"], expected, "{request}, switches={bits}");
                                assert_eq!(text["item_digest"], sha256_hex(expected.as_bytes()));
                                assert_eq!(text["tool_names"], json!(expected_names));
                                assert_eq!(
                                    text["composition_digest"],
                                    json!(sha256_hex(
                                        &serde_jcs::to_vec(&request["composition"]).unwrap()
                                    ))
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn frozen_legacy_sources_keep_the_original_text_revision() {
    let definition = tool_catalog::definition();
    let before = json!({
        "texts": legacy_texts(),
        "descriptions": definition.descriptions,
        "parameters": definition.parameter_descriptions,
        "language_names": definition.language_names,
    });
    assert_eq!(
        sha256_hex(&serde_jcs::to_vec(&before).unwrap()),
        "bf069036fcd1b7f4006c1f119fd9e44797ab777b40bfb10cbb4be5735dcefd90"
    );
}

fn legacy_texts() -> &'static BTreeMap<String, String> {
    static TEXTS: std::sync::OnceLock<BTreeMap<String, String>> = std::sync::OnceLock::new();
    TEXTS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../testdata/tool-catalog-legacy-texts.json"
        ))
        .unwrap()
    })
}

// Preserve the former renderer against frozen sources, not a conversion of the
// new templates: a migration error must not change both sides of the comparison.
fn legacy_render(name: &str, flags: &TextFlags, values: &BTreeMap<&str, String>) -> String {
    let template = &legacy_texts()[name];
    let mut out = String::new();
    let mut open: Vec<(&str, bool)> = Vec::new();
    let mut rest = template.as_str();
    loop {
        let keeping = open.iter().all(|(_, keep)| *keep);
        let Some(start) = rest.find("{{") else {
            if keeping {
                out.push_str(rest);
            }
            break;
        };
        if keeping {
            out.push_str(&rest[..start]);
        }
        let after = &rest[start + 2..];
        let end = after.find("}}").expect("terminated legacy tag");
        let tag = &after[..end];
        rest = &after[end + 2..];
        let mut chars = tag.chars();
        match chars.next() {
            Some(sigil @ ('#' | '^')) => {
                let flag = chars.as_str();
                let on = match flag {
                    "memory" => flags.memory,
                    "dreamer" => flags.dreamer,
                    "temporal" => flags.temporal,
                    "caveman" => flags.caveman,
                    "language" => flags.language,
                    _ => panic!("unknown legacy flag {flag}"),
                };
                open.push((flag, if sigil == '#' { on } else { !on }));
            }
            Some('/') => assert_eq!(open.pop().unwrap().0, chars.as_str()),
            Some('$') => {
                let value = &values[chars.as_str()];
                if keeping {
                    out.push_str(value);
                }
            }
            _ if !tag.is_empty()
                && tag
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b == b'_' || b == b'/') =>
            {
                if keeping {
                    out.push_str(&legacy_render(tag, flags, values));
                }
            }
            _ => panic!("malformed legacy tag {tag}"),
        }
    }
    assert!(open.is_empty());
    out
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
    assert_eq!(tags.len(), 15, "{tags:?}");
    assert!(tags
        .iter()
        .any(|tag| tag == "magic-context:context.keep/v1"));
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
    // Oh My Pi's provider spelling, which here is the same as Pi's.
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
                vec!["ctx_reduce", "ctx_expand", "ctx_search", "ctx_keep"]
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
    // The user override affects head text with or without compaction; workers ignore it.
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

#[test]
fn the_module_only_defaults_declare_no_commands_and_no_smart_notes() {
    // What ck-mc serves with no configuration file. It runs neither the
    // slash commands nor smart notes yet, so a compacting head's catalog
    // offers neither.
    let config = crate::config::Config::from(crate::pass::Settings::default()).catalog_config(None);
    for surface in ["full", "light"] {
        let answer =
            tool_catalog::catalog_answer(&role_request("head", true, surface), &config).unwrap();
        assert!(answer.get("user_commands").is_none(), "{surface}");
        assert!(answer.get("capabilities").is_none(), "{surface}");
        let note = answer["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "ctx_note")
            .unwrap();
        assert!(note["input_schema"]["properties"]
            .get("surface_condition")
            .is_none());
        let text = answer["system_text"]["text"].as_str().unwrap();
        assert!(
            !text.to_ascii_lowercase().contains("smart note"),
            "{surface}"
        );
    }
}
