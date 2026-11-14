//! The tagged sample set `mc-app-read-samples-v17`: the v16 set with the
//! new read `dreamer.docs_proposal {project}`, the project's pending
//! docs-upkeep proposal for the dreamer page. Three examples are added, read
//! from a fixture store and checkout: a pending proposal (one change kept,
//! one dropped with its reason), a known project with none, and a project
//! the reads don't know. Every v16 file is copied byte for byte.
//!
//! Regenerate deliberately from the workspace root:
//! `MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib
//! app_read::samples_v17_tests::samples_v17 -- --exact`. Set the variable
//! to an output directory instead of `1` for a read-only checkout.

use sha2::{Digest, Sha256};

use super::*;
use crate::dreamer::tasks::maintain_docs::tests::{changed, Fixture, PROJECT};

/// The samples v17 adds to v16's.
const ADDED: [&str; 3] = [
    "docs-proposal-none.json",
    "docs-proposal-unknown.json",
    "docs-proposal.json",
];

/// The time every example's envelope names, as the earlier sets fix it.
const AS_OF_MS: u64 = 1_700_000_000_000;

fn sample(name: &str, params: &Value, response: Result<Value, Refusal>) -> Vec<u8> {
    let response = match response {
        Ok(mut result) => {
            result["as_of_ms"] = json!(AS_OF_MS);
            json!({"result": result})
        }
        Err(refusal) => json!({"error": refusal}),
    };
    let value = json!({
        "name": name,
        "request": {"method": docs::METHOD, "params": params},
        "response": response,
    });
    format!("{}\n", serde_json::to_string_pretty(&value).unwrap()).into_bytes()
}

/// A proposal that keeps one change and drops one: a section added with a
/// date in it.
fn answer() -> Value {
    json!([
        {
            "file": "ARCHITECTURE.md",
            "action": "replace",
            "heading": "## Core",
            "text": "## Core\nThe parser lives in src/parse/ now.",
            "reason": "src/parser.rs moved to src/parse/.",
        },
        {
            "file": "STRUCTURE.md",
            "action": "add",
            "heading": "## History",
            "text": "## History\nThe parser moved on 2026-11-14.",
            "reason": "Record the move.",
        },
    ])
}

#[test]
fn samples_v17() {
    let testdata = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata");
    let v16 = testdata.join("mc-app-read-samples-v16");
    let mut samples = BTreeMap::<String, Vec<u8>>::new();
    for line in std::fs::read_to_string(v16.join("SHA256SUMS"))
        .unwrap()
        .lines()
    {
        let (_, name) = line.split_once("  ").unwrap();
        samples.insert(name.into(), std::fs::read(v16.join(name)).unwrap());
    }
    let copied = samples.len();
    let fixture = Fixture::documented();
    changed(&fixture);
    let batch = fixture.batch();
    let applied = fixture.apply(&batch, &answer());
    assert_eq!((applied.applied, applied.dropped.len()), (1, 1));
    let mut read = |name: &str, params: Value, known: bool| -> Value {
        let response = docs::read(Some(&fixture.db), known, &params);
        let bytes = sample(name, &params, response.clone());
        assert!(
            samples.insert(format!("{name}.json"), bytes).is_none(),
            "{name}"
        );
        response.unwrap_or_else(|refusal| json!({"refusal": refusal.code}))
    };
    let pending = read("docs-proposal", json!({"project": PROJECT}), true);
    assert_eq!(pending["proposal"]["status"], "pending");
    assert_eq!(pending["proposal"]["dropped"][0]["heading"], "## History");
    let none = read("docs-proposal-none", json!({"project": "pj-empty"}), true);
    assert_eq!(none["proposal"], Value::Null);
    let unknown = read(
        "docs-proposal-unknown",
        json!({"project": "pj-unknown"}),
        false,
    );
    assert_eq!(unknown["refusal"], "project_unknown");
    assert_eq!(samples.len(), copied + ADDED.len());

    let mut root = testdata.join("mc-app-read-samples-v17");
    let output = std::env::var_os("MC_REGENERATE_APP_READ_SAMPLES");
    let regenerate = output.is_some();
    if let Some(output) = output.filter(|value| value != "1") {
        root = output.into();
    }
    if regenerate {
        std::fs::create_dir_all(&root).unwrap();
    }
    let mut sums = String::new();
    for (name, bytes) in &samples {
        let decoded: Value = serde_json::from_slice(bytes).unwrap();
        assert!(decoded["request"]["method"].is_string());
        // Every reply stays under the frame budget.
        assert!(bytes.len() < REPLY_BUDGET, "{name}");
        sums.push_str(&format!("{:x}  {name}\n", Sha256::digest(bytes)));
        // Only a file whose bytes change is written, so regenerating leaves
        // the copied v16 files alone.
        if regenerate && std::fs::read(root.join(name)).ok().as_ref() != Some(bytes) {
            std::fs::write(root.join(name), bytes).unwrap();
        }
        assert_eq!(
            &std::fs::read(root.join(name)).unwrap_or_else(|_| panic!("missing sample {name}")),
            bytes,
            "stale {name}"
        );
    }
    if regenerate {
        std::fs::write(root.join("SHA256SUMS"), &sums).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(root.join("SHA256SUMS")).unwrap(),
        sums,
        "stale sample checksums"
    );
    // Against v16: every v16 file is copied byte for byte, and only the
    // added samples are new.
    let in_v16: std::collections::BTreeSet<String> =
        std::fs::read_to_string(v16.join("SHA256SUMS"))
            .unwrap()
            .lines()
            .map(|line| line.split_once("  ").unwrap().1.to_owned())
            .collect();
    for name in &in_v16 {
        assert_eq!(
            std::fs::read(root.join(name)).unwrap(),
            std::fs::read(v16.join(name)).unwrap(),
            "{name} differs from v16"
        );
    }
    assert_eq!(
        samples
            .keys()
            .filter(|name| !in_v16.contains(name.as_str()))
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ADDED
    );
}
