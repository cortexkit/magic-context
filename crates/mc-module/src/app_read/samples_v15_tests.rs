//! The tagged sample set `mc-app-read-samples-v15`: the v14 set with the
//! `context.head` samples that show memories written again, because the
//! outline now names levels: each `memory` section carries the level of its
//! block (the workspace's or the project's), and each `memory_updates` item
//! the `level` and `category` its line names. One sample is added, a head
//! with both memory blocks. The owner reads (memories, the dreamer, a
//! project's sessions, notes and candidate facts) and their watch notices
//! are read from the fixture store as in v13. The v12, v13 and v14 folders
//! stay as they were tagged.
//!
//! Regenerate deliberately from the workspace root:
//! `MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib
//! app_read::samples_v15_tests::samples_v15 -- --exact`. Set the variable
//! to an output directory instead of `1` for a read-only checkout.

use super::fixture_tests::{head, Fixture, EMPTY, FORMS, PROJECT};
use super::*;

/// The v14 samples v15 writes again: every head outline with a memory
/// section or a memory update. Every other v14 file is copied unchanged.
const CHANGED: [&str; 8] = [
    "head-empty-delta.json",
    "head-no-items.json",
    "head-no-mural.json",
    "head-other.json",
    "head-pending-view.json",
    "head-shared.json",
    "head-utf8.json",
    "head.json",
];

/// The samples v15 adds to v14's.
const ADDED: [&str; 1] = ["head-workspace.json"];

/// Times and cursors that change from run to run, fixed as v12 fixes them.
const AS_OF_MS: u64 = 1_700_000_000_000;

fn sample(name: &str, method: &str, params: &Value, response: Result<Value, Refusal>) -> Vec<u8> {
    let response = match response {
        Ok(mut result) => {
            result["as_of_ms"] = json!(AS_OF_MS);
            json!({"result": result})
        }
        Err(refusal) => json!({"error": refusal}),
    };
    let value = json!({"name": name, "request": {"method": method, "params": params}, "response": response});
    format!("{}\n", serde_json::to_string_pretty(&value).unwrap()).into_bytes()
}

fn notice_sample(name: &str, params: &Value, mut notice: Value) -> Vec<u8> {
    notice["cursor"] = json!("abc:1");
    let value = json!({"name": name, "request": {"method": "context.watch", "params": params}, "response": {"result": notice}});
    format!("{}\n", serde_json::to_string_pretty(&value).unwrap()).into_bytes()
}

#[tokio::test]
async fn samples_v15() {
    let mut samples = BTreeMap::<String, Vec<u8>>::new();
    let v12 =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/mc-app-read-samples-v12");
    for line in std::fs::read_to_string(v12.join("SHA256SUMS"))
        .unwrap()
        .lines()
    {
        let (_, name) = line.split_once("  ").unwrap();
        samples.insert(name.into(), std::fs::read(v12.join(name)).unwrap());
    }
    let copied = samples.len();
    let mut rewritten = BTreeMap::new();
    super::head::tests::head_samples(&mut rewritten);
    assert!(rewritten
        .keys()
        .all(|name| samples.contains_key(name) || ADDED.contains(&name.as_str())));
    samples.extend(rewritten.clone());
    let fixture = Fixture::new();
    let mut replica = fixture.replica();
    let mut read = |name: &str, method: &str, params: Value| -> Value {
        let response = replica.read(method, &params);
        let bytes = sample(name, method, &params, response.clone());
        assert!(
            samples.insert(format!("{name}.json"), bytes).is_none(),
            "{name}"
        );
        response.unwrap_or_else(|refusal| json!({"refusal": refusal.code}))
    };
    let project = |extra: Value| {
        let mut params = json!({"level": "project", "owner": PROJECT});
        for (key, value) in extra.as_object().unwrap() {
            params[key] = value.clone();
        }
        params
    };
    // memories.stats
    read("memories-stats", "memories.stats", project(json!({})));
    read(
        "memories-stats-global",
        "memories.stats",
        json!({"level": "global"}),
    );
    read(
        "memories-stats-empty",
        "memories.stats",
        json!({"level": "project", "owner": EMPTY}),
    );
    read(
        "memories-stats-unknown",
        "memories.stats",
        json!({"level": "project", "owner": "pj-unknown"}),
    );
    // memories.page
    let first = read(
        "memories-page",
        "memories.page",
        project(json!({"limit": 3})),
    );
    read(
        "memories-page-2",
        "memories.page",
        project(json!({"limit": 3, "cursor": first["next"]})),
    );
    read(
        "memories-page-empty",
        "memories.page",
        json!({"level": "project", "owner": EMPTY}),
    );
    read(
        "memories-page-global",
        "memories.page",
        json!({"level": "global"}),
    );
    read(
        "memories-page-search",
        "memories.page",
        project(json!({"text": "execute threshold", "status": "all"})),
    );
    read(
        "memories-page-bad-cursor",
        "memories.page",
        project(json!({"status": "archived", "cursor": first["next"]})),
    );
    // memories.get: one memory with history from each writer, one with
    // none, and a refusal.
    read("memories-get-agent", "memories.get", json!({"id": 1}));
    read("memories-get-summary", "memories.get", json!({"id": 2}));
    read("memories-get-dreamer", "memories.get", json!({"id": 3}));
    read("memories-get-person", "memories.get", json!({"id": 4}));
    read("memories-get-merged", "memories.get", json!({"id": 6}));
    read("memories-get-no-history", "memories.get", json!({"id": 7}));
    read("memories-get-not-found", "memories.get", json!({"id": 999}));
    // observations.page
    let first = read(
        "observations-page",
        "observations.page",
        json!({"limit": 2}),
    );
    read(
        "observations-page-2",
        "observations.page",
        json!({"limit": 2, "cursor": first["next"]}),
    );
    read(
        "observations-page-invalid-limit",
        "observations.page",
        json!({"limit": 0}),
    );
    // facts.page
    let first = read(
        "facts-page",
        "facts.page",
        json!({"project": PROJECT, "limit": 2}),
    );
    read(
        "facts-page-2",
        "facts.page",
        json!({"project": PROJECT, "limit": 2, "cursor": first["next"]}),
    );
    read("facts-page-empty", "facts.page", json!({"project": EMPTY}));
    read(
        "facts-page-unknown",
        "facts.page",
        json!({"project": "pj-unknown"}),
    );
    // dreamer.status
    read(
        "dreamer-status",
        "dreamer.status",
        json!({"project": PROJECT}),
    );
    read(
        "dreamer-status-forms",
        "dreamer.status",
        json!({"project": FORMS}),
    );
    read(
        "dreamer-status-empty",
        "dreamer.status",
        json!({"project": EMPTY}),
    );
    read(
        "dreamer-status-unknown",
        "dreamer.status",
        json!({"project": "pj-unknown"}),
    );
    // dreamer.runs
    let first = read(
        "dreamer-runs",
        "dreamer.runs",
        json!({"project": PROJECT, "limit": 2}),
    );
    read(
        "dreamer-runs-2",
        "dreamer.runs",
        json!({"project": PROJECT, "limit": 2, "cursor": first["next"]}),
    );
    read(
        "dreamer-runs-empty",
        "dreamer.runs",
        json!({"project": EMPTY}),
    );
    read(
        "dreamer-runs-bad-cursor",
        "dreamer.runs",
        json!({"project": PROJECT, "task": "swe:compress-cues", "cursor": first["next"]}),
    );
    // dreamer.run
    read("dreamer-run", "dreamer.run", json!({"id": 2}));
    read("dreamer-run-running", "dreamer.run", json!({"id": 3}));
    read("dreamer-run-not-found", "dreamer.run", json!({"id": 99}));
    // sessions.page
    let first = read(
        "sessions-page",
        "sessions.page",
        json!({"project": PROJECT, "limit": 2}),
    );
    read(
        "sessions-page-2",
        "sessions.page",
        json!({"project": PROJECT, "limit": 2, "cursor": first["next"]}),
    );
    read(
        "sessions-page-empty",
        "sessions.page",
        json!({"project": EMPTY, "preset": "reader"}),
    );
    read(
        "sessions-page-unknown",
        "sessions.page",
        json!({"project": "pj-unknown"}),
    );
    // notes.page
    let first = read(
        "notes-page",
        "notes.page",
        json!({"project": PROJECT, "limit": 3}),
    );
    read(
        "notes-page-2",
        "notes.page",
        json!({"project": PROJECT, "limit": 3, "cursor": first["next"]}),
    );
    read("notes-page-empty", "notes.page", json!({"project": EMPTY}));
    read(
        "notes-page-invalid-type",
        "notes.page",
        json!({"project": PROJECT, "type": "memo"}),
    );
    // context.watch with owners, and one notice of each new kind.
    let params = json!({"projects": [PROJECT], "global": true});
    let mut watch = replica.subscribe("direct".into(), &params).unwrap();
    let mut resync = watch.recv().await.unwrap().unwrap();
    resync["cursor"] = json!("abc:0");
    let value = json!({"name": "watch-owners", "request": {"method": "context.watch", "params": params}, "response": {"result": resync}});
    samples.insert(
        "watch-owners.json".into(),
        format!("{}\n", serde_json::to_string_pretty(&value).unwrap()).into_bytes(),
    );
    for (name, change) in [
        ("watch-memories", Change::project_memories(PROJECT)),
        (
            "watch-dreamer",
            Change::Dreamer {
                project: PROJECT.into(),
            },
        ),
        (
            "watch-notes",
            Change::Notes {
                project: PROJECT.into(),
                session: Some(head()),
            },
        ),
    ] {
        replica.watches.publish(change);
        let notice = watch.recv().await.unwrap().unwrap();
        samples.insert(format!("{name}.json"), notice_sample(name, &params, notice));
    }
    assert_eq!(samples.len(), copied + 47 + ADDED.len());
    let mut root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/mc-app-read-samples-v15");
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
    // The v12 examples the head doesn't write are copied unchanged.
    for line in std::fs::read_to_string(v12.join("SHA256SUMS"))
        .unwrap()
        .lines()
    {
        let (_, name) = line.split_once("  ").unwrap();
        if rewritten.contains_key(name) {
            continue;
        }
        assert_eq!(
            std::fs::read(root.join(name)).unwrap(),
            std::fs::read(v12.join(name)).unwrap(),
            "{name} differs from v12"
        );
    }
    // Against v14: the changed samples differ, every other v14 file is
    // copied byte for byte, and only the added samples are new.
    let v14 =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/mc-app-read-samples-v14");
    let mut in_v14 = std::collections::BTreeSet::new();
    let v14_sums = std::fs::read_to_string(v14.join("SHA256SUMS")).unwrap();
    for line in v14_sums.lines() {
        let (_, name) = line.split_once("  ").unwrap();
        in_v14.insert(name);
        let changed = std::fs::read(root.join(name)).unwrap_or_else(|_| panic!("missing {name}"))
            != std::fs::read(v14.join(name)).unwrap();
        assert_eq!(
            changed,
            CHANGED.contains(&name),
            "{name}: changed from v14 is {changed}"
        );
    }
    assert_eq!(
        samples
            .keys()
            .filter(|name| !in_v14.contains(name.as_str()))
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ADDED
    );
}
