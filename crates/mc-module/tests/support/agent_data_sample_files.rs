//! Golden agent-data bodies shared by the wire and in-process producers.

use std::collections::BTreeMap;
use std::path::PathBuf;

use cortexkit_role_agent_data as contract;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Default)]
pub struct Samples(BTreeMap<String, Vec<u8>>);

fn round_trip<T: DeserializeOwned + Serialize>(value: &Value) {
    let decoded: T = serde_json::from_value(value.clone()).expect("contract must decode the body");
    assert_eq!(
        serde_json::to_value(decoded).unwrap(),
        *value,
        "contract discarded or changed members"
    );
}

impl Samples {
    fn insert(&mut self, name: &str, value: &Value) {
        let bytes = format!("{}\n", serde_json::to_string_pretty(value).unwrap()).into_bytes();
        assert!(self.0.insert(format!("{name}.json"), bytes).is_none());
    }

    pub fn request(&mut self, name: &str, method: &str, params: Value) -> Value {
        let request = contract::request::Request::decode(method, &params).unwrap();
        assert_eq!(request.params(), params, "request lost members");
        let body = json!({"method": method, "params": params});
        self.insert(&format!("{name}-request"), &body);
        body
    }

    pub fn reply(&mut self, name: &str, op: &str, value: &Value) {
        match op {
            "describe" => round_trip::<contract::describe::DescribeReply>(value),
            "busy" => round_trip::<contract::busy::BusyReply>(value),
            "status" => round_trip::<contract::status::StatusReply>(value),
            "prepare" => round_trip::<contract::prepare::PrepareReply>(value),
            "export" => round_trip::<contract::export::ExportReply>(value),
            "diverged" => round_trip::<contract::diverged::DivergedReply>(value),
            "import" => round_trip::<contract::import::ImportReply>(value),
            "release" => round_trip::<contract::release::ReleaseReply>(value),
            "activate" | "abort" => round_trip::<contract::EmptyReply>(value),
            _ => panic!("unknown operation {op}"),
        }
        self.insert(&format!("{name}-reply"), value);
    }

    pub fn refusal(&mut self, name: &str, value: &Value) {
        round_trip::<contract::errors::ErrorBody>(value);
        let body: contract::errors::ErrorBody = serde_json::from_value(value.clone()).unwrap();
        assert!(
            body.code.is_known(),
            "unlisted refusal: {}",
            body.code.as_str()
        );
        body.typed_detail().unwrap();
        body.digest_mismatch_detail().unwrap();
        body.participant_failed_detail().unwrap();
        if let Some(request) = self.0.get(&format!("{name}-request.json")) {
            let request: Value = serde_json::from_slice(request).unwrap();
            let op = contract::Op::from_method(request["method"].as_str().unwrap()).unwrap();
            assert!(
                contract::errors::may_refuse(op, &body.code),
                "refusal is not allowed for {op:?}"
            );
        }
        self.insert(&format!("{name}-refusal"), value);
    }

    pub fn finish(self, prefix: &str) {
        let committed =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata/mc-agent-data-samples-v2");
        let mut root = committed.clone();
        let output = std::env::var_os("MC_REGENERATE_AGENT_DATA_SAMPLES");
        let regenerate = output.is_some();
        if let Some(output) = output.filter(|value| value != "1") {
            root = output.into();
        }
        if regenerate {
            std::fs::create_dir_all(&root).unwrap();
            if root != committed {
                std::fs::write(
                    root.join("README.md"),
                    std::fs::read(committed.join("README.md")).unwrap(),
                )
                .unwrap();
            }
        }
        for (name, bytes) in &self.0 {
            assert!(name.starts_with(prefix));
            if regenerate {
                std::fs::write(root.join(name), bytes).unwrap();
            }
            assert_eq!(
                std::fs::read(root.join(name)).unwrap_or_else(|_| panic!("missing {name}")),
                *bytes,
                "stale {name}"
            );
            println!("sample {name}: {} bytes", bytes.len());
        }
        let mut files = BTreeMap::new();
        for entry in std::fs::read_dir(&root).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().into_string().unwrap();
            if name == "SHA256SUMS" {
                continue;
            }
            assert!(
                name == "README.md" || name.ends_with(".json"),
                "unexpected file {name}"
            );
            assert!(
                name == "README.md"
                    || ["wire-", "service-", "receiver-", "source-"]
                        .iter()
                        .any(|prefix| name.starts_with(prefix)),
                "unowned sample prefix {name}"
            );
            if name.starts_with(prefix) {
                assert!(self.0.contains_key(&name), "unowned sample {name}");
            }
            files.insert(name, std::fs::read(entry.path()).unwrap());
        }
        assert!(files.contains_key("README.md"));
        let sums: String = files
            .iter()
            .map(|(name, bytes)| format!("{:x}  {name}\n", Sha256::digest(bytes)))
            .collect();
        if regenerate {
            std::fs::write(root.join("SHA256SUMS"), &sums).unwrap();
        }
        assert_eq!(
            std::fs::read_to_string(root.join("SHA256SUMS")).unwrap(),
            sums,
            "stale SHA256SUMS"
        );
    }
}
