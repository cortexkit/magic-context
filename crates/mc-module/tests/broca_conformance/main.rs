//! Version-one Broca provider conformance through the executable and subc wire.
#![cfg(target_os = "linux")]

mod compaction;
mod fixture;
mod harness;
mod hooks;

use cortexkit_role_compaction_provider as compact;
use cortexkit_role_step_transform_provider as transform;
use serde_json::{json, Value};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn role_describe_and_existing_tool_provider_surface() {
    let rig = harness::Rig::start(None, false).await;
    let identity = rig.identity("roles");
    let describe = rig.method(&identity, "role.describe", json!({})).await;
    compact::describe::check_describe(&describe).unwrap();
    transform::describe::check_describe(&describe).unwrap();
    assert_eq!(describe["runner_groups"], json!(["transcript_reads"]));
    let majors = describe["majors"].as_array().unwrap();
    assert_eq!(majors.len(), 3);
    for version in ["tool-provider/v1", compact::PROVIDES, transform::PROVIDES] {
        assert!(majors.iter().any(|major| major["version"] == version));
    }
    let legacy = rig
        .call(&identity, json!({"name":"role.describe","arguments":{}}))
        .await;
    assert_eq!(legacy, describe);
    let request = json!({"name":"tool.catalog","arguments":{"preset":"head"}});
    let before = rig.call(&identity, request.clone()).await;
    let names = tool_names(&before);
    assert!(names.contains(&"ctx_search"));
    assert!(names.contains(&"ctx_memory"));
    assert!(names.contains(&"ctx_note"));
    assert!(!names.contains(&"ctx_reduce"));
    for name in [
        "role.describe",
        "compaction.setup",
        "compaction.step",
        "transform.declare",
        "transform.hook",
    ] {
        assert!(
            !names.contains(&name),
            "provider method exposed as tool: {name}"
        );
    }
    rig.method(&identity, "transform.declare", json!({"params":{}}))
        .await;
    assert_eq!(rig.call(&identity, request).await, before);
}

fn tool_names(value: &Value) -> Vec<&str> {
    value["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect()
}
