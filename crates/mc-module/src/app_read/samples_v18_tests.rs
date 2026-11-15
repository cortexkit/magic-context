//! The tagged sample set `mc-app-read-samples-v18`: the v17 set with the
//! `views` form of `context.cache_why`, which answers ck-mc's record of each
//! view version a session's steps rendered under. Three examples are added:
//! records of every cause and every status (and one cause the apps don't
//! know yet) with a version ck-mc has no record of, a request whose versions
//! ck-mc never built, and the refusal of 101 versions. Every v17 file is
//! copied byte for byte, including `cache-why.json`, the `producers` form,
//! which this generator also reads again and finds unchanged.
//!
//! The records are made through a session's own paths
//! ([`crate::session::Session::app_sample_decisions`]) with pinned times, and
//! are read at the fixed time every example's envelope names, so the
//! retention period counts from it.
//!
//! Regenerate deliberately from the workspace root:
//! `MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib
//! app_read::samples_v18_tests::samples_v18 -- --exact`. Set the variable
//! to an output directory instead of `1` for a read-only checkout.

use sha2::{Digest, Sha256};

use super::tests::{fixture, replica, request};
use super::*;

/// The samples v18 adds to v17's.
const ADDED: [&str; 3] = [
    "cache-why-views-missing.json",
    "cache-why-views-too-many.json",
    "cache-why-views.json",
];

/// The time every example's envelope names, as the earlier sets fix it.
const AS_OF_MS: u64 = 1_700_000_000_000;

const METHOD: &str = "context.cache_why";

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
        "request": {"method": METHOD, "params": params},
        "response": response,
    });
    format!("{}\n", serde_json::to_string_pretty(&value).unwrap()).into_bytes()
}

#[test]
fn samples_v18() {
    let testdata = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata");
    let v17 = testdata.join("mc-app-read-samples-v17");
    let mut samples = BTreeMap::<String, Vec<u8>>::new();
    for line in std::fs::read_to_string(v17.join("SHA256SUMS"))
        .unwrap()
        .lines()
    {
        let (_, name) = line.split_once("  ").unwrap();
        samples.insert(name.into(), std::fs::read(v17.join(name)).unwrap());
    }
    let copied = samples.len();

    // The `producers` form still reads exactly as the v17 example shows.
    let mut replica = replica(None);
    replica.snapshots.clear();
    replica.publish(crate::session::Session::app_sample_snapshot());
    let params = request(json!({"producers":[{"producer_ref":"runner-step"}]}));
    assert_eq!(
        sample("cache-why", &params, replica.read(METHOD, &params)),
        samples["cache-why.json"],
        "the producers form changed"
    );

    let decisions = crate::session::Session::app_sample_decisions(AS_OF_MS - 60_000);
    let causes: Vec<_> = decisions.iter().map(|record| &record["cause"]).collect();
    assert_eq!(
        causes,
        [
            "over_limit",
            "explicit_flush",
            "cache_lost",
            "history_changed",
            "history_refresh",
            "execute",
            "some_future_cause"
        ]
    );
    let statuses: Vec<_> = decisions.iter().map(|record| &record["status"]).collect();
    assert_eq!(
        statuses,
        [
            "applied",
            "applied",
            "accepted",
            "refused",
            "undelivered",
            "offered",
            "accepted"
        ]
    );
    let versions: Vec<u64> = decisions
        .iter()
        .map(|record| record["view_version"].as_u64().unwrap())
        .collect();
    let newest = *versions.iter().max().unwrap();
    let mut read = |name: &str, views: Value| -> Value {
        let params = request(json!({ "views": views }));
        // The reply as the replica makes it, at the examples' fixed time.
        let response = cache_why::views(None, &fixture().key, &decisions, &views, AS_OF_MS).map(
            |mut fields| {
                envelope(METHOD, &mut fields);
                fields
            },
        );
        let bytes = sample(name, &params, response.clone());
        assert!(
            samples.insert(format!("{name}.json"), bytes).is_none(),
            "{name}"
        );
        response.unwrap_or_else(|refusal| json!({"refusal": refusal.code}))
    };
    let mut requested: Vec<u64> = versions.iter().rev().copied().collect();
    requested.push(newest + 1);
    let found = read("cache-why-views", json!(requested));
    assert_eq!(found["decisions"].as_array().unwrap().len(), versions.len());
    assert_eq!(found["missing"], json!([newest + 1]));
    let missing = read("cache-why-views-missing", json!([newest + 40]));
    assert_eq!(missing["decisions"], json!([]));
    assert_eq!(missing["missing"], json!([newest + 40]));
    let too_many: Vec<u64> = (1..=101).collect();
    let refused = read("cache-why-views-too-many", json!(too_many));
    assert_eq!(refused["refusal"], "invalid_params");
    // The replica refuses the same request alike.
    assert_eq!(
        replica
            .read(METHOD, &request(json!({ "views": too_many })))
            .unwrap_err()
            .code,
        "invalid_params"
    );
    assert_eq!(samples.len(), copied + ADDED.len());

    let mut root = testdata.join("mc-app-read-samples-v18");
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
        // the copied v17 files alone.
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
    // Against v17: every v17 file is copied byte for byte, and only the
    // added samples are new.
    let in_v17: std::collections::BTreeSet<String> =
        std::fs::read_to_string(v17.join("SHA256SUMS"))
            .unwrap()
            .lines()
            .map(|line| line.split_once("  ").unwrap().1.to_owned())
            .collect();
    for name in &in_v17 {
        assert_eq!(
            std::fs::read(root.join(name)).unwrap(),
            std::fs::read(v17.join(name)).unwrap(),
            "{name} differs from v17"
        );
    }
    assert_eq!(
        samples
            .keys()
            .filter(|name| !in_v17.contains(name.as_str()))
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ADDED
    );
}
