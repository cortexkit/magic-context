//! The tagged sample set `mc-app-read-samples-v16`: the v15 set with one
//! example added, `token-breakdown-long.json`, a token breakdown read from a
//! real long head session so the apps can test realistic proportions. It
//! isn't generated: the module's stored checkpoint for that session was
//! copied into the sample's envelope. So the test checks the set rather than
//! writing it: v15 is copied byte for byte, the checksums are current, and
//! the added row reads and writes back through the module's own breakdown
//! type unchanged.

use sha2::{Digest, Sha256};

use super::*;

const ADDED: &str = "token-breakdown-long.json";

#[test]
fn v16_is_v15_plus_a_breakdown_from_a_real_long_session() {
    let testdata = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata");
    let v15 = testdata.join("mc-app-read-samples-v15");
    let v16 = testdata.join("mc-app-read-samples-v16");
    let names = |root: &std::path::Path| -> Vec<String> {
        std::fs::read_to_string(root.join("SHA256SUMS"))
            .unwrap()
            .lines()
            .map(|line| line.split_once("  ").unwrap().1.to_owned())
            .collect()
    };
    let earlier = names(&v15);
    for name in &earlier {
        assert_eq!(
            std::fs::read(v16.join(name)).unwrap(),
            std::fs::read(v15.join(name)).unwrap(),
            "{name} differs from v15"
        );
    }
    let mut expected: Vec<String> = earlier.clone();
    expected.push(ADDED.into());
    expected.sort();
    assert_eq!(names(&v16), expected, "v16 adds exactly one sample");
    let mut sums = String::new();
    for name in &expected {
        let bytes = std::fs::read(v16.join(name)).unwrap();
        sums.push_str(&format!("{:x}  {name}\n", Sha256::digest(&bytes)));
    }
    assert_eq!(
        std::fs::read_to_string(v16.join("SHA256SUMS")).unwrap(),
        sums,
        "stale sample checksums"
    );

    let bytes = std::fs::read(v16.join(ADDED)).unwrap();
    assert!(bytes.len() < REPLY_BUDGET);
    let sample: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(sample["request"]["method"], "session_data.read");
    assert_eq!(sample["request"]["params"]["section"], "token_breakdown");
    let row = &sample["response"]["result"]["row"];
    let breakdown = Breakdown::from_value(row.clone());
    assert_eq!(
        serde_json::to_string(&breakdown).unwrap(),
        serde_json::to_string(row).unwrap(),
        "the stored row reads and writes back unchanged"
    );
    // What makes it worth adding: a long session with estimates and a real
    // time, unlike every earlier breakdown example.
    assert!(row["total"]["tokens"].as_u64().unwrap() > 500_000);
    assert!(row["as_of"]["at_ms"].as_u64().unwrap() > 1_000_000_000_000);
    let parts = row["parts"].as_array().unwrap();
    assert!(parts.iter().any(|part| part["estimate"] == true));
    let summaries = row["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["item"] == "summary")
        .count();
    assert!(summaries > 100);
}
