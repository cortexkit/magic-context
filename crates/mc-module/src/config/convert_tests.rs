//! `convert_0_49` against the shapes today's reader accepts, the 0.49
//! leftovers, and real-looking user files.

use serde_json::{json, Value};

use super::convert::convert_0_49;
use super::edit::{apply, Edit};

/// The file after conversion, and the notes.
pub(super) fn convert(file: &Value) -> (Value, Vec<String>) {
    let (edits, notes) = convert_0_49(file);
    let text = apply(&file.to_string(), &edits).expect("the edits apply");
    (
        serde_json::from_str(&text).expect("the result is JSON"),
        notes,
    )
}

/// Real-looking 0.49 user files, by name. Each is something a person could
/// have in `~/.config/cortexkit/magic-context.jsonc` today, and none holds a
/// value the converter can't convert (a literal key, `{env:…}`).
pub(super) fn corpus() -> Vec<(&'static str, Value)> {
    vec![
        ("empty", json!({})),
        (
            "an OpenCode user on the plugin's defaults with a few changes",
            json!({
                "$schema": "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json",
                "execute_threshold_percentage": {"default": 70, "anthropic/claude-opus-5-5": 80},
                "cache_ttl": {"default": "5m", "anthropic/claude-opus-5-5": "1h"},
                "protected_tags": 20,
                "historian": {"model": "anthropic/claude-haiku-5-5", "two_pass": true},
                "dreamer": {
                    "model": "anthropic/claude-sonnet-5-5",
                    "disable": false,
                    "tasks": {
                        "verify": {"schedule": "0 4 * * *", "model": "anthropic/claude-sonnet-5-5"},
                        "retrospective": {"schedule": "0 5 * * *"},
                        "maintain-docs": {"schedule": "", "max_tokens": 12000}
                    }
                },
                "embedding": {"provider": "local", "model": "nomic-embed-text-v1.5"},
                "memory": {"enabled": true, "injection_budget_tokens": 6000, "retrieval_count_promotion_threshold": 3},
                "temporal_awareness": true,
                "clock_note": "1h"
            }),
        ),
        (
            "a person on a hosted embedding endpoint and reranker",
            json!({
                "embedding": {
                    "provider": "openai-compatible",
                    "endpoint": "https://api.voyageai.com/v1",
                    "model": "voyage-3",
                    "api_key": "{vault:voyage}",
                    "input_type": "document",
                    "query_input_type": "query",
                    "query_instruction": false,
                    "document_prefix": "passage: ",
                    "truncate": "END",
                    "dimensions": 1024,
                    "max_input_tokens": 8000
                },
                "rerank": {
                    "provider": "remote",
                    "endpoint": "https://api.cohere.com/v2",
                    "model": "rerank-v3.5",
                    "api_key": "{vault:cohere}",
                    "timeout_ms": 20000,
                    "top_n": 10
                },
                "keep_reasoning_tokens": 4000
            }),
        ),
        (
            "a person who switched things off",
            json!({
                "clock_note": false,
                "rerank": {"provider": "off"},
                "dreamer": {"disable": true, "maxTokens": 5000000},
                "caveman_text_compression": {"enabled": true, "min_chars": 800},
                "commit_cluster_trigger": {"enabled": false, "min_clusters": 5},
                "compaction": {"enabled": false},
                "keep_subagents": true,
                "language": "tr",
                "mural": {"enabled": true, "model": "ignored"},
                "memory": {
                    "auto_promote": false,
                    "auto_search": {"enabled": false, "score_threshold": 0.7, "min_prompt_chars": 40},
                    "git_commit_indexing": {"enabled": true, "since_days": 90, "max_commits": 5000}
                },
                "history_budget_percentage": 0.25
            }),
        ),
        (
            "a file with values today's reader ignores",
            json!({
                "execute_threshold_percentage": 95,
                "keep_reasoning_tokens": {"default": 5000, "openai/*": 0, "bad key": 3, "google/gemini-3-pro": 2000000},
                "protected_tokens": 100,
                "history_budget_percentage": 0.9,
                "clock_note": "soon",
                "prompt_surface": {
                    "default": "compact",
                    "models": {"anthropic/claude-opus-5-5": "light", "openai/gpt-5": "tiny"},
                    "tool_descriptions": {"ctx_search": "Search everything.", "ctx_unknown": "Nothing."}
                },
                "embedding": {"provider": "ollama", "module": "not a module", "dimensions": 99999},
                "rerank": {"provider": 3, "top_n": 50, "timeout_ms": 12.5},
                "dreamer": {"projects": "every", "maxTokens": -1, "tasks": {"verify": {"schedule": "every day"}, "curate": "weekly"}},
                "memory": {"enabled": "yes", "injection_budget_tokens": 100}
            }),
        ),
        (
            "model maps with provider and model names of every kind",
            json!({
                "execute_threshold_tokens": {
                    "openrouter/anthropic/claude-3.5-sonnet": 150000,
                    "qwen2.5:7b": 30000,
                    "default": 120000
                },
                "keep_reasoning_tokens": {"google-vertex-anthropic/claude-3-5-sonnet@20240620": 2000, "openai/*": 1000},
                "protected_tokens": 12000,
                "protected_tools": {"mcp_read": 2, "todowrite": 0},
                "prompt_surface": {"models": {"default": "light", "openrouter/x-ai/grok-5": "full"}}
            }),
        ),
        (
            "a dreamer limited to some projects, on a federated Synapse",
            json!({
                "dreamer": {
                    "projects": [" git:abc ", "dir:def"],
                    "tasks": {"curate-workspace": {"schedule": "0 1 * * 1"}, "promote-primers": {"schedule": "0 3 * * *"}}
                },
                "embedding": {"provider": "synapse", "module": "fed:0123456789abcdef0123456789abcdef:synapse"},
                "rerank": {"module": " synapse ", "provider": "synapse"},
                "prompt_surface": {"guidance_override_text": "## Magic Context\nKeep it short.", "default": "light"}
            }),
        ),
    ]
}

#[test]
fn each_reshape_converts_as_the_design_table_says() {
    for (file, converted) in [
        (json!({"clock_note": false}), json!({"clock_note": "off"})),
        (json!({"clock_note": "30m"}), json!({"clock_note": "30m"})),
        (
            json!({"clock_note": " 045m "}),
            json!({"clock_note": "45m"}),
        ),
        (
            json!({"execute_threshold_percentage": 70}),
            json!({"execute_threshold_percentage": {"default": 70}}),
        ),
        (
            json!({"execute_threshold_percentage": {"default": 70, "openai/gpt-5": 60}}),
            json!({"execute_threshold_percentage": {"default": 70, "openai/gpt-5": 60}}),
        ),
        (
            json!({"execute_threshold_tokens": {"anthropic/claude-opus-5-5": 150000}}),
            json!({"execute_threshold_tokens": {"anthropic/claude-opus-5-5": 150000}}),
        ),
        (
            json!({"keep_reasoning_tokens": 5000}),
            json!({"keep_reasoning_tokens": {"default": 5000}}),
        ),
        (
            json!({"keep_reasoning_tokens": {"default": 5000, "anthropic/*": 0}}),
            json!({"keep_reasoning_tokens": {"default": 5000, "anthropic/*": 0}}),
        ),
        (
            json!({"protected_tokens": 8000}),
            json!({"protected_tokens": {"kind": "tokens", "tokens": 8000}}),
        ),
        (
            json!({"embedding": {"query_instruction": false}}),
            json!({"embedding": {"query_instruction": {"kind": "none"}}}),
        ),
        (
            json!({"embedding": {"query_instruction": "Represent this query: "}}),
            json!({"embedding": {"query_instruction": {"kind": "text", "text": "Represent this query: "}}}),
        ),
        (
            json!({"embedding": {"document_prefix": ""}}),
            json!({"embedding": {"document_prefix": {"kind": "text", "text": ""}}}),
        ),
        (
            json!({"embedding": {"provider": "local"}}),
            json!({"embedding": {"provider": "synapse"}}),
        ),
        (
            json!({"embedding": {"provider": "openai-compatible", "api_key": "{vault:openai}"}}),
            json!({"embedding": {"provider": "openai-compatible", "api_key": {"kind": "vault", "key": {"vault_ref": "openai"}}}}),
        ),
        (
            json!({"rerank": {"api_key": " {vault: cohere } "}}),
            json!({"rerank": {}, "rerank_backend": {"api_key": {"kind": "vault", "key": {"vault_ref": "cohere"}}}}),
        ),
        (
            json!({"rerank": {"provider": "off", "module": "synapse"}}),
            json!({"rerank": {"enabled": false}, "rerank_backend": {"module": "synapse"}}),
        ),
        (
            json!({"rerank": {"provider": "off", "enabled": true}}),
            json!({"rerank": {"enabled": false}}),
        ),
        (
            json!({"rerank": {"provider": "cohere"}}),
            json!({"rerank": {}, "rerank_backend": {"provider": "synapse"}}),
        ),
        (
            json!({"rerank": {"provider": "remote", "timeout_ms": 20000}}),
            json!({"rerank": {"timeout_ms": 15000}, "rerank_backend": {"provider": "remote"}}),
        ),
        (
            json!({"dreamer": {"disable": true}}),
            json!({"dreamer": {"enabled": false}}),
        ),
        (
            json!({"dreamer": {"disable": false}}),
            json!({"dreamer": {"enabled": true}}),
        ),
        (
            json!({"dreamer": {"maxTokens": 5000000}}),
            json!({"dreamer": {"max_tokens": 5000000}}),
        ),
        (
            json!({"dreamer": {"maxTokens": 5000000, "max_tokens": 1}}),
            json!({"dreamer": {"max_tokens": 5000000}}),
        ),
        (
            json!({"dreamer": {"projects": [" git:abc ", "dir:def"]}}),
            json!({"dreamer": {"projects": {"kind": "listed", "projects": ["git:abc", "dir:def"]}}}),
        ),
        (
            json!({"dreamer": {"tasks": {"verify": {"schedule": "0 4 * * *"}, "retrospective": {"schedule": "0 5 * * *"}}}}),
            json!({"dreamer": {"tasks": {"verify": {"schedule": "0 4 * * *"}}}}),
        ),
        (
            json!({"temporal_awareness": true, "language": "en"}),
            json!({"language": "en"}),
        ),
    ] {
        let (actual, _) = convert(&file);
        assert_eq!(actual, converted, "{file}");
    }
}

#[test]
fn values_todays_reader_ignores_are_removed_with_a_note_naming_them() {
    for (file, pointer) in [
        (
            json!({"execute_threshold_percentage": 95}),
            "/execute_threshold_percentage",
        ),
        (
            json!({"execute_threshold_percentage": {"default": 10}}),
            "/execute_threshold_percentage/default",
        ),
        (
            json!({"execute_threshold_tokens": {"x": 10}}),
            "/execute_threshold_tokens/x",
        ),
        (
            json!({"keep_reasoning_tokens": -5}),
            "/keep_reasoning_tokens",
        ),
        (
            json!({"keep_reasoning_tokens": {"bad key": 3}}),
            "/keep_reasoning_tokens/bad key",
        ),
        (json!({"protected_tokens": 100}), "/protected_tokens"),
        (
            json!({"protected_tools": {"read": 1.5}}),
            "/protected_tools/read",
        ),
        (
            json!({"history_budget_percentage": 0.9}),
            "/history_budget_percentage",
        ),
        (json!({"memory": {"enabled": "yes"}}), "/memory/enabled"),
        (json!({"memory": "on"}), "/memory"),
        (json!({"clock_note": "soon"}), "/clock_note"),
        (json!({"clock_note": true}), "/clock_note"),
        (
            json!({"prompt_surface": {"default": "compact"}}),
            "/prompt_surface/default",
        ),
        (
            json!({"prompt_surface": {"models": {"x": "tiny"}}}),
            "/prompt_surface/models/x",
        ),
        (
            json!({"prompt_surface": {"tool_descriptions": {"ctx_unknown": "x"}}}),
            "/prompt_surface/tool_descriptions/ctx_unknown",
        ),
        (
            json!({"embedding": {"module": "not a module"}}),
            "/embedding/module",
        ),
        (
            json!({"embedding": {"dimensions": 99999}}),
            "/embedding/dimensions",
        ),
        (
            json!({"embedding": {"query_instruction": true}}),
            "/embedding/query_instruction",
        ),
        (json!({"rerank": {"top_n": 50}}), "/rerank/top_n"),
        (
            json!({"rerank": {"timeout_ms": 12.5}}),
            "/rerank/timeout_ms",
        ),
        (json!({"dreamer": {"maxTokens": -1}}), "/dreamer/maxTokens"),
        (
            json!({"dreamer": {"tasks": {"verify": {"schedule": "every day"}}}}),
            "/dreamer/tasks/verify/schedule",
        ),
        (
            json!({"dreamer": {"tasks": {"curate": "weekly"}}}),
            "/dreamer/tasks/curate",
        ),
    ] {
        let (edits, notes) = convert_0_49(&file);
        assert!(edits.contains(&Edit::remove(pointer)), "{file}: {edits:?}");
        assert!(
            notes
                .iter()
                .any(|note| note.starts_with(&format!("{pointer}: "))),
            "{file}: {notes:?}"
        );
    }
    // Converted to what today's reader made of them.
    for (file, converted) in [
        (
            json!({"embedding": {"provider": "ollama"}}),
            json!({"embedding": {"provider": "off"}}),
        ),
        (
            json!({"dreamer": {"projects": "every"}}),
            json!({"dreamer": {"projects": {"kind": "listed", "projects": []}}}),
        ),
        (
            json!({"execute_threshold_tokens": {"default": 120000.5}}),
            json!({"execute_threshold_tokens": {"default": 120000}}),
        ),
    ] {
        let (actual, notes) = convert(&file);
        assert_eq!(actual, converted, "{file}");
        assert!(!notes.is_empty(), "{file}");
    }
}

#[test]
fn a_literal_key_or_an_expansion_stays_with_a_note_naming_the_field() {
    for (file, pointer) in [
        (
            json!({"embedding": {"api_key": "sk-literal"}}),
            "/embedding/api_key",
        ),
        (
            json!({"rerank": {"api_key": "{env:COHERE_KEY}"}}),
            "/rerank/api_key",
        ),
        (
            json!({"embedding": {"endpoint": "{env:EMBED_URL}/v1"}}),
            "/embedding/endpoint",
        ),
        (
            json!({"prompt_surface": {"guidance_override_text": "{file:guidance.md}"}}),
            "/prompt_surface/guidance_override_text",
        ),
        (json!({"language": "{env:LANG}"}), "/language"),
    ] {
        let (edits, notes) = convert_0_49(&file);
        assert!(edits.is_empty(), "{file}: {edits:?}");
        assert!(
            notes
                .iter()
                .any(|note| note.starts_with(&format!("{pointer}: "))),
            "{file}: {notes:?}"
        );
    }
    let (_, notes) = convert_0_49(&json!({"embedding": {"api_key": "sk-literal"}}));
    assert!(notes[0].contains("vault"), "{notes:?}");
    // An empty key sends no key today; absent says the same.
    let (converted, _) = convert(&json!({"embedding": {"api_key": " "}}));
    assert_eq!(converted, json!({"embedding": {}}));
}

#[test]
fn keys_outside_the_schema_are_removed_and_the_plugins_are_named_as_its() {
    let file = json!({
        "cache_ttl": "5m",
        "historian": {"model": "x"},
        "dreamer": {"model": "y", "tasks": {"retrospective": {"schedule": ""}, "verify": {"model": "z"}}},
        "embedding": {"local_runtime": "onnx"},
        "made_up": 1,
        "memory": {"made_up": true}
    });
    let (edits, notes) = convert_0_49(&file);
    for pointer in [
        "/cache_ttl",
        "/historian",
        "/dreamer/model",
        "/dreamer/tasks/retrospective",
        "/dreamer/tasks/verify/model",
        "/embedding/local_runtime",
    ] {
        assert!(edits.contains(&Edit::remove(pointer)), "{pointer}");
        assert!(
            notes.contains(&format!(
                "{pointer}: belonged to the 0.49 plugin and means nothing to ck-mc; removed (the old file is saved)"
            )),
            "{pointer}: {notes:?}"
        );
    }
    for pointer in ["/made_up", "/memory/made_up"] {
        assert!(edits.contains(&Edit::remove(pointer)), "{pointer}");
        assert!(notes.contains(&format!("{pointer}: not a ck-mc setting; removed")));
    }
}

#[test]
fn converting_a_converted_file_changes_nothing() {
    let mut files = corpus();
    files.push((
        "every reshape at once",
        json!({
            "clock_note": false,
            "execute_threshold_percentage": 70,
            "keep_reasoning_tokens": 5000,
            "protected_tokens": 8000,
            "embedding": {"provider": "local", "query_instruction": "q: ", "document_prefix": "d: ", "api_key": "{vault:e}"},
            "rerank": {"provider": "off", "api_key": "{vault:r}"},
            "dreamer": {"disable": true, "maxTokens": 9, "projects": ["p"], "branches": {"pj-a": ["release/1.x"]}, "tasks": {"verify": {"schedule": "0 1 * * *"}}},
            "temporal_awareness": false
        }),
    ));
    // A literal key stays, so the second pass notes it again but edits nothing.
    files.push((
        "a literal key",
        json!({"embedding": {"api_key": "sk-literal"}}),
    ));
    for (name, file) in files {
        let (converted, _) = convert(&file);
        let (edits, _) = convert_0_49(&converted);
        assert!(edits.is_empty(), "{name}: {edits:?}");
    }
}

#[test]
fn every_converted_file_passes_the_daemons_review() {
    let schema = super::review::schema();
    for (name, file) in corpus() {
        let (converted, _) = convert(&file);
        let tuple = schema
            .review_tuple(
                &[subc_client_rs::config::LayerValue::new(
                    subc_client_rs::config::Layer::User,
                    converted.clone(),
                )],
                &subc_client_rs::config::ValidationContext::new("magic-context", None),
            )
            .unwrap_or_else(|refusal| panic!("{name}: {refusal:?} for {converted}"));
        let problems = super::review::checks(
            &tuple.effective,
            std::path::Path::new("/settings/magic-context.jsonc"),
        );
        assert!(problems.is_empty(), "{name}: {problems:?}");
    }
}

#[test]
fn the_converted_text_keeps_the_comments_of_a_real_looking_file() {
    let text = r#"{
  "$schema": "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json",
  // Summarize a little later than the default.
  "execute_threshold_percentage": 70,
  // Tell me the time every hour; false turns it off.
  "clock_note": false,
  "temporal_awareness": true, // obsolete in 0.50
  "embedding": {
    "provider": "local" // runs on this machine
  },
  "rerank": {
    "provider": "off" // use vector scores as-is
  },
  "dreamer": {
    /* Off while I travel. */
    "disable": true,
    "maxTokens": 5000000
  }
}
"#;
    let parsed = super::jsonc::parse(text);
    let (edits, _) = convert_0_49(&parsed.value);
    let converted = apply(text, &edits).expect("the rewrite applies");
    assert_eq!(
        converted,
        r#"{
  // Summarize a little later than the default.
  "execute_threshold_percentage": {
    "default": 70
  },
  // Tell me the time every hour; false turns it off.
  "clock_note": "off",
  // obsolete in 0.50
  "embedding": {
    "provider": "synapse" // runs on this machine
  },
  "rerank": {
    "enabled": false // use vector scores as-is
  },
  "dreamer": {
    /* Off while I travel. */
    "enabled": false,
    "max_tokens": 5000000
  }
}
"#
    );
}

#[test]
fn the_last_value_is_converted_and_the_bom_and_crlf_are_kept() {
    let text =
        "\u{feff}{\r\n  \"clock_note\": \"1h\",\r\n  \"clock_note\": false // quiet\r\n}\r\n";
    let (edits, _) = convert_0_49(&super::jsonc::parse(text).value);
    assert_eq!(
        apply(text, &edits).unwrap(),
        "\u{feff}{\r\n  \"clock_note\": \"1h\",\r\n  \"clock_note\": \"off\" // quiet\r\n}\r\n"
    );
}

#[test]
fn dreamer_branches_survives_conversion() {
    let file = json!({"dreamer": {"branches": {"pj-a": ["master", "release/1.x"]}}});
    let (edits, notes) = convert_0_49(&file);
    assert!(edits.is_empty(), "{edits:?} {notes:?}");
    let (edits, _) = convert_0_49(&json!({"dreamer": {"branches": ["master"]}}));
    assert_eq!(edits, [Edit::remove("/dreamer/branches")]);
}

/// Every setting the schema declares, written at its default, comes through
/// the conversion untouched. A setting added to the schema and the reader but
/// not to the converter would otherwise be removed from the person's file at
/// every start, as "not a ck-mc setting".
#[test]
fn every_schema_default_survives_conversion() {
    let schema = super::review::schema_value();
    let mut checked = 0;
    for field in super::review::fields() {
        let node = field
            .pointer
            .split('/')
            .skip(1)
            .try_fold(schema, |node, key| node.get("properties")?.get(key));
        let Some(default) = node.and_then(|node| node.get("default")) else {
            continue;
        };
        let mut file = json!({});
        let mut slot = &mut file;
        let keys: Vec<&str> = field.pointer.split('/').skip(1).collect();
        for key in &keys[..keys.len() - 1] {
            slot = slot
                .as_object_mut()
                .unwrap()
                .entry(*key)
                .or_insert_with(|| json!({}));
        }
        slot.as_object_mut()
            .unwrap()
            .insert(keys[keys.len() - 1].to_owned(), default.clone());
        let (edits, notes) = convert_0_49(&file);
        assert!(edits.is_empty(), "{}: {edits:?} {notes:?}", field.pointer);
        checked += 1;
    }
    assert!(checked > 20, "only {checked} schema defaults were checked");
}
