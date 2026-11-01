//! Byte pins for what `guidance.get` and `manifest.get` serve today.
//!
//! Thalamus (Claude Code) and Broca read these answers and freeze them per session, so
//! any byte change is a cache event for every live session. The golden file holds each
//! answer exactly as served for a fixed set of requests; a change that is meant to move
//! them has to rewrite the file on purpose, and one that is not fails here.

use super::*;

/// Set this variable to rewrite the golden file from the current module output.
const BLESS_ENV: &str = "MC_BLESS_GUIDANCE_GET_GOLDEN";

/// The date line every answer carries. `guidance.get` keeps the first date it served a
/// session in the session's stored meta, so seeding it here makes the bytes stable.
const PINNED_DATE_LINE: &str = "Today's date: Thu Jan 01 2026";

fn golden_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join("guidance-get-golden.json")
}

fn pin_guidance_date(store: &McStore, session_id: &str) {
    let loaded = store.load_meta(session_id).unwrap();
    let mut meta = loaded.meta.clone();
    meta.guidance_date = PINNED_DATE_LINE.to_string();
    store
        .commit_meta(session_id, loaded.row_version, &meta)
        .unwrap();
}

/// Every request the golden pins, by name. They cover each guidance variant
/// (reduce-capable and no-reduce, full and light), both serializer profiles that pick
/// a variant, the language directive, a request-supplied override and the
/// `manifest.get` tool list with and without a description override.
fn cases() -> Vec<(String, Value)> {
    let mut cases = Vec::new();
    for (profile_name, profile) in [
        ("claude-code", Value::Null),
        ("owned-broca", json!("owned-broca")),
    ] {
        for preset in ["full", "light"] {
            for tool_present in [true, false] {
                let name = format!(
                    "guidance.get/{profile_name}/{preset}/{}",
                    if tool_present { "reduce" } else { "no-reduce" }
                );
                let mut request = json!({
                    "kind": "guidance.get",
                    "session_id": "ses",
                    "preset": preset,
                    "tool_present": tool_present,
                });
                if !profile.is_null() {
                    request["serializer_profile"] = profile.clone();
                }
                cases.push((name, request));
            }
        }
    }
    cases.push((
        "guidance.get/claude-code/full/reduce/language-fr".to_string(),
        json!({
            "kind": "guidance.get",
            "session_id": "ses",
            "tool_present": true,
            "language": "fr",
        }),
    ));
    cases.push((
        "guidance.get/claude-code/full/reduce/override".to_string(),
        json!({
            "kind": "guidance.get",
            "session_id": "ses",
            "tool_present": true,
            "guidance_override": "A user's own guidance section.",
        }),
    ));
    for preset in ["full", "light"] {
        cases.push((
            format!("manifest.get/{preset}"),
            json!({"kind": "manifest.get", "session_id": "ses", "preset": preset}),
        ));
    }
    cases.push((
        "manifest.get/full/description-override".to_string(),
        json!({
            "kind": "manifest.get",
            "session_id": "ses",
            "tool_descriptions": {"ctx_search": "Search this project's archive."},
        }),
    ));
    cases
}

#[tokio::test(flavor = "current_thread")]
async fn guidance_and_manifest_answers_match_the_golden_bytes() {
    let (handler, store, _dir, _project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    pin_guidance_date(&store, "ses");
    let mut served = serde_json::Map::new();
    for (name, request) in cases() {
        let outcome = handler.dispatch_value(7, request).await;
        let HandlerOutcome::Response(bytes) = outcome else {
            panic!("{name}: unexpected outcome {outcome:?}");
        };
        // The answer's exact bytes, not a re-serialization, are what callers freeze.
        served.insert(name, Value::String(String::from_utf8(bytes).unwrap()));
    }
    let actual = format!(
        "{}\n",
        serde_json::to_string_pretty(&Value::Object(served)).unwrap()
    );
    let path = golden_path();
    if std::env::var_os(BLESS_ENV).is_some() {
        std::fs::write(&path, &actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("{}: {error}; set {BLESS_ENV}=1 to write it", path.display())
    });
    assert!(
        expected == actual,
        "guidance.get or manifest.get bytes changed; rerun with {BLESS_ENV}=1 only if that is intended"
    );
}
