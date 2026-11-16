//! The tagged sample set `mc-context-read-samples-v1`: what Colliculus reads
//! of `mc-context-read/v1` for its voice front. `role.describe`, the newest
//! summaries at tier 1 (`context.summaries` with `newest`), a session's
//! newest messages as the summarizer's lines (`context.recent`), the same
//! with its newest line cut to the budget, and the `unknown_session` and
//! `transient` refusals of `context.recent`. Every file holds one request
//! and its reply, made by the module's own code on synthetic sessions.
//!
//! Regenerate deliberately from the workspace root:
//! `MC_REGENERATE_CONTEXT_READ_SAMPLES=1 cargo test --locked -p mc-module
//! --lib context_read::samples_tests::samples_v1 -- --exact`. Set the
//! variable to an output directory instead of `1` for a read-only checkout.

use super::recent_tests::{recent_params, Fixture, HARNESS};
use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;

/// `role.describe` names the build it ran on; the sample shows this in its
/// place, so a version bump leaves the file as it is.
const VERSION_PLACEHOLDER: &str = "{implementation_version}";

fn pretty(value: &Value) -> Vec<u8> {
    format!("{}\n", serde_json::to_string_pretty(value).unwrap()).into_bytes()
}

/// One read as Colliculus sends it on its context route, and the reply as
/// the route carries it: `{"result": ...}`, or `{"error": ...}` with the
/// refusal's body.
async fn exchange(fixture: &Fixture, name: &str, method: &str, params: Value) -> (Vec<u8>, Value) {
    let request = json!({"method": method, "params": params});
    let response = match fixture
        .module
        .context_read()
        .read(&serde_json::to_vec(&request).unwrap())
        .await
    {
        Ok(reply) => json!({"result": reply}),
        Err(refusal) => json!({"error": refusal}),
    };
    let mut shown = response.clone();
    if let Some(version) = shown
        .pointer_mut("/result/implementation_version")
        .filter(|version| **version == json!(crate::version_line()))
    {
        *version = json!(VERSION_PLACEHOLDER);
    }
    let bytes = pretty(&json!({
        "name": name,
        "caller": "reserved:colliculus",
        "request": request,
        "response": shown,
    }));
    (bytes, response)
}

#[tokio::test]
async fn samples_v1() {
    let fixture = Fixture::new("ses_live", &[]);
    let live = SessionRef::new("thalamus-harness", HARNESS, "ses_live");
    fixture.set_up(&live).await;
    // A session whose Setup could not read its transcript from the runner.
    let unread = SessionRef::new("thalamus-harness", HARNESS, "ses_unread");
    fixture.runner.0.fail.store(true, Ordering::SeqCst);
    fixture.set_up(&unread).await;
    fixture.runner.0.fail.store(false, Ordering::SeqCst);

    let mut samples = BTreeMap::<String, Vec<u8>>::new();
    let (bytes, describe) = exchange(&fixture, "describe", "role.describe", json!({})).await;
    assert_eq!(
        describe["result"]["majors"][0]["ops"],
        json!(["context.memories", "context.summaries", "context.recent"])
    );
    assert_eq!(
        describe["result"]["implementation_version"],
        crate::version_line()
    );
    samples.insert("describe.json".into(), bytes);

    let (bytes, summaries) = exchange(
        &fixture,
        "summaries-newest",
        "context.summaries",
        json!({"session": {"harness": HARNESS, "session": "ses_live"}, "budget_tokens": 4000, "newest": 2}),
    )
    .await;
    let items = summaries["result"]["summaries"].as_array().unwrap();
    assert_eq!(
        items
            .iter()
            .map(|item| item["id"].clone())
            .collect::<Vec<_>>(),
        [json!("2"), json!("1")]
    );
    assert_eq!(
        items[0]["text"],
        "## 5-6 \u{b7} The off-by-one fix\nThe off-by-one fix: the full account."
    );
    samples.insert("summaries-newest.json".into(), bytes);

    let (bytes, recent) = exchange(
        &fixture,
        "recent",
        "context.recent",
        recent_params("ses_live", 4000),
    )
    .await;
    assert_eq!(recent["result"]["from_message"], 1);
    assert_eq!(recent["result"]["through_message"], 10);
    assert!(recent["result"].get("cut").is_none());
    assert!(recent["result"]["tokens"].as_u64().unwrap() <= 4000);
    samples.insert("recent.json".into(), bytes);

    let (bytes, cut) = exchange(
        &fixture,
        "recent-cut",
        "context.recent",
        recent_params("ses_live", 256),
    )
    .await;
    assert_eq!(cut["result"]["cut"], true);
    assert!(cut["result"]["tokens"].as_u64().unwrap() <= 256);
    samples.insert("recent-cut.json".into(), bytes);

    let (bytes, unknown) = exchange(
        &fixture,
        "recent-unknown-session",
        "context.recent",
        recent_params("ses_unknown", 1000),
    )
    .await;
    assert_eq!(unknown["error"]["code"], "unknown_session");
    samples.insert("recent-unknown-session.json".into(), bytes);

    let (bytes, transient) = exchange(
        &fixture,
        "recent-transient",
        "context.recent",
        recent_params("ses_unread", 1000),
    )
    .await;
    assert_eq!(transient["error"]["code"], "transient");
    assert_eq!(transient["error"]["detail"]["retry_after_ms"], 2000);
    samples.insert("recent-transient.json".into(), bytes);
    assert_eq!(samples.len(), 6);

    let mut root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata/mc-context-read-samples-v1");
    let output = std::env::var_os("MC_REGENERATE_CONTEXT_READ_SAMPLES");
    let regenerate = output.is_some();
    if let Some(output) = output.filter(|value| value != "1") {
        root = output.into();
    }
    if regenerate {
        std::fs::create_dir_all(&root).unwrap();
    }
    let mut sums = String::new();
    for (name, bytes) in &samples {
        sums.push_str(&format!("{:x}  {name}\n", Sha256::digest(bytes)));
        if regenerate {
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
    // Nothing else in the folder but its notes.
    for entry in std::fs::read_dir(&root).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        assert!(
            name == "README.md" || name == "SHA256SUMS" || samples.contains_key(&name),
            "unexpected file {name}"
        );
    }
}
