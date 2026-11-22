use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use subc_control::config::{ConfigControlRequest, ConfigControlResponse, ConfigWatchResponse};
use subc_protocol::config::{
    ConfigAppliedRequest, ConfigChanged, ConfigGetReply, ConfigGetRequest,
};

fn decode<T: DeserializeOwned>(value: &Value, name: &str) -> T {
    serde_json::from_value(value.clone()).unwrap_or_else(|error| panic!("{name}: {error}"))
}

#[test]
fn pinned_project_config_samples_decode() {
    let folder =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/config-settings-v1");
    let manifest = std::fs::read_to_string(folder.join("SHA256SUMS")).unwrap();
    assert_eq!(manifest.lines().count(), 26);
    for line in manifest.lines() {
        let (hash, name) = line.split_once("  ").unwrap();
        let bytes = std::fs::read(folder.join(name)).unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), hash, "{name}");
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        if name == "project-changed.json" {
            let changed: ConfigChanged = decode(&value, name);
            assert!(changed.project_id.is_some(), "{name}");
        } else if name == "project-watch.request.json" {
            let _: ConfigControlRequest = decode(&value, name);
        } else if name.starts_with("project-watch.") {
            let _: ConfigWatchResponse = decode(&value, name);
        } else {
            let request = &value["request"];
            let reply = &value["reply"];
            match request["op"].as_str().expect(name) {
                "config.get" => {
                    let request: ConfigGetRequest = decode(request, name);
                    let reply: ConfigGetReply = decode(reply, name);
                    let view = reply.pending.or(reply.active).expect(name);
                    assert_eq!(view.project_id, request.project_id, "{name}");
                }
                "config.applied" => {
                    let request: ConfigAppliedRequest = decode(request, name);
                    assert!(request.project_id.is_some(), "{name}");
                    assert_eq!(reply, &json!({"op": "config.applied"}), "{name}");
                }
                _ => {
                    let _: ConfigControlRequest = decode(request, name);
                    if reply.get("code").is_some() {
                        let _: subc_protocol::ErrorBody = decode(reply, name);
                    } else {
                        let _: ConfigControlResponse = decode(reply, name);
                    }
                }
            }
        }
    }
}
