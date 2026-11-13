use cortexkit_role_tool_provider::catalog::{composition_digest, CatalogAnswer, CatalogTool};
use serde_json::{json, Value};

use super::*;

fn tool(name: &str, capabilities: &[&str]) -> CatalogTool {
    let mut tool = CatalogTool::default();
    tool.name = name.to_owned();
    tool.capabilities = capabilities.iter().map(|tag| (*tag).to_owned()).collect();
    tool
}

fn answer(tools: Vec<CatalogTool>) -> CatalogAnswer {
    let mut answer = CatalogAnswer::default();
    answer.tools = tools;
    answer
}

fn reader(name: &str, capabilities: &[&str]) -> ReaderTool {
    ReaderTool {
        name: name.to_owned(),
        capabilities: capabilities.iter().map(|tag| (*tag).to_owned()).collect(),
    }
}

#[test]
fn a_read_only_catalog_gives_its_tools() {
    let tools = reader_tools(&answer(vec![
        tool("read", &["code.read/v1"]),
        tool("grep", &[]),
    ]))
    .unwrap();
    assert_eq!(
        tools,
        vec![reader("read", &["code.read/v1"]), reader("grep", &[])]
    );
}

#[test]
fn a_catalog_that_can_change_the_project_is_refused() {
    for name in [
        "bash",
        "edit",
        "write",
        "delete",
        "move",
        "apply_patch",
        "ast_replace",
    ] {
        let error = reader_tools(&answer(vec![tool("read", &[]), tool(name, &[])])).unwrap_err();
        assert!(error.contains(name), "{name}: {error}");
    }
    for tag in ["code.edit/v1", "shell.exec/v1"] {
        let error = reader_tools(&answer(vec![tool("helper", &[tag])])).unwrap_err();
        assert!(error.contains(tag), "{tag}: {error}");
    }
}

#[test]
fn an_empty_catalog_is_refused() {
    assert!(reader_tools(&answer(Vec::new())).is_err());
}

/// The shape Prefrontal core's worker plans use, which the Agent Runner and
/// Broca check: items
/// as written, providers and tools in canonical order, and a digest of the
/// composition exactly as sent.
#[test]
fn the_plan_has_the_shape_runners_admit() {
    let tools = vec![
        reader("zoom", &[]),
        reader("read", &["prefrontal:x/v1", "code.read/v1"]),
        reader("grep", &[]),
    ];
    let plan = plan(&tools, "magic-context", "You verify memories.").unwrap();
    assert_eq!(
        plan["composition"],
        json!({
            "providers": [
                {"provider": "aft", "tools": [
                    {"capabilities": [], "name": "grep"},
                    {"capabilities": ["code.read/v1", "prefrontal:x/v1"], "name": "read"},
                    {"capabilities": [], "name": "zoom"},
                ]},
                {"provider": "magic-context", "tools": []},
            ],
            "step_transform_items": [],
        })
    );
    assert_eq!(
        plan["composition_digest"],
        json!(composition_digest(&plan["composition"]).unwrap())
    );
    assert_eq!(
        plan["tool_items"],
        json!([{"params": {}, "preset": "reader", "provider": "aft"}])
    );
    assert_eq!(
        plan["system_text_items"],
        json!([{"params": {"text": "You verify memories."}, "preset": "dreamer", "provider": "magic-context"}])
    );
    assert_eq!(plan["step_transform_items"], json!([]));
}

/// The composition names exactly the providers the items name, which the
/// Agent Runner and Broca both require.
#[test]
fn the_composition_names_exactly_the_items_providers() {
    let plan = plan(&[reader("read", &[])], "magic-context", "system").unwrap();
    let named = |items: &Value| -> Vec<String> {
        items
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["provider"].as_str().unwrap().to_owned())
            .collect()
    };
    let mut from_items = named(&plan["tool_items"]);
    from_items.extend(named(&plan["system_text_items"]));
    from_items.sort();
    assert_eq!(from_items, named(&plan["composition"]["providers"]));
}

#[test]
fn a_tool_listed_twice_is_refused() {
    let error = plan(
        &[reader("read", &[]), reader("read", &[])],
        "magic-context",
        "r",
    )
    .unwrap_err();
    assert!(error.contains("read"), "{error}");
}

/// Under a module id that sorts before `aft`, the providers still come out
/// sorted, so the plan doesn't depend on the id ck-mc runs under.
#[test]
fn providers_stay_sorted_whatever_the_module_id() {
    let plan = plan(&[reader("read", &[])], "ab-mc", "r").unwrap();
    let providers: Vec<&str> = plan["composition"]["providers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|provider| provider["provider"].as_str().unwrap())
        .collect();
    assert_eq!(providers, vec!["ab-mc", "aft"]);
}

/// Writes the plan a verify child would be created with, against AFT's
/// reader tools as core's sidekick sample lists them, so a runner's owner can
/// run it through admission. `DREAMER_PLAN_SAMPLE` names the output file.
#[test]
#[ignore = "writes a sample for runner owners"]
fn write_plan_sample() {
    let Some(out) = std::env::var_os("DREAMER_PLAN_SAMPLE") else {
        return;
    };
    let tools = [
        reader("glob", &[]),
        reader("grep", &[]),
        reader("outline", &[]),
        reader("read", &["code.read/v1"]),
        reader("search", &[]),
        reader("zoom", &[]),
    ];
    let plan = plan(
        &tools,
        crate::MODULE_ID,
        "You check memories against the project's code. Read the files each memory names, then answer with one manifest.",
    )
    .unwrap();
    let mut runner_params = serde_json::Map::new();
    runner_params.insert(
        "model".into(),
        json!({"provider": "anthropic", "model": "claude-opus-5-5"}),
    );
    runner_params.insert("generation".into(), json!({"max_output_tokens": 32000}));
    runner_params.insert("stop_when".into(), json!({"max_steps": 60}));
    let mut send = serde_json::Map::new();
    send.insert(
        "prompt".into(),
        json!("### Memories to verify\n[7863] The tool catalog is a pure function of its request."),
    );
    send.insert("send_id".into(), json!("mc-dream:42:0.0"));
    send.insert("plan".into(), plan);
    send.extend(runner_params);
    std::fs::write(
        out,
        serde_json::to_vec_pretty(&Value::Object(send)).unwrap(),
    )
    .unwrap();
}
