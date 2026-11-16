//! The tagged sample set `mc-attribution-samples-v1`: what Astrocyte sees of
//! the attribution facts on the wire. An `attribution.read` page holding two
//! facts (a summary child with its head and agent, and a dreamer child with
//! a project and no parent), the next page after it, which is empty, the
//! refusal of a caller other than `reserved:astrocyte`, and the
//! `attribution_fact` event of the first fact: its subject with the account
//! as `{acct}`, every header, and its body.
//!
//! Regenerate deliberately from the workspace root:
//! `MC_REGENERATE_ATTRIBUTION_SAMPLES=1 cargo test --locked -p mc-module
//! --lib attribution::samples_tests::samples_v1 -- --exact`. Set the variable
//! to an output directory instead of `1` for a read-only checkout.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};
use subc_protocol::Principal;

use super::tests::{put, store};
use super::*;

/// When the summary child was created; the dreamer child a minute later.
const CREATED_AT: i64 = 1_767_225_600_000;
/// The bus account the event's subject is derived for, then shown as
/// `{acct}`.
const ACCOUNT: &str = "box_test";

fn pretty(value: &Value) -> Vec<u8> {
    format!("{}\n", serde_json::to_string_pretty(value).unwrap()).into_bytes()
}

/// One read as `caller` sends it on ck-mc's management surface, and the
/// reply: `{"result": ...}`, or `{"error": ...}` with the refusal's body.
fn exchange(name: &str, db: &ContextDb, caller: &str, params: Value) -> (Vec<u8>, Value) {
    let request = json!({"method": read::METHOD, "params": params});
    let principal = match caller.strip_prefix("reserved:") {
        Some(module_id) => Principal::Reserved {
            module_id: module_id.into(),
        },
        None => Principal::Direct,
    };
    let body = serde_json::to_vec(&request).unwrap();
    let response = match read::admit(&principal).and_then(|()| read::handle(Some(db), &body)) {
        Ok(reply) => reply,
        Err(refusal) => json!({"error": refusal}),
    };
    let bytes = pretty(&json!({
        "name": name,
        "caller": caller,
        "request": request,
        "response": response,
    }));
    (bytes, response)
}

#[test]
fn samples_v1() {
    let (_dir, db) = store();
    let head = SessionRef::new("thalamus-harness", "opencode2", "ses_head1");
    let summary_child = SessionRef::new(
        "thalamus-harness",
        "opencode2",
        "ses_head1:mc-summary:12-48:dec_7f3a:turn-one",
    );
    let dream_child = SessionRef::new("broca", "broca", "mc-dream:42.0:0.0");
    put(
        &db,
        &summary_child,
        &Purpose::summary(&head, Some("agent_7c1e"), Some("pj-3f9a")),
        CREATED_AT,
    );
    put(
        &db,
        &dream_child,
        &Purpose::dream("map-memories", Some("pj-3f9a")),
        CREATED_AT + 60_000,
    );

    let mut samples = BTreeMap::<String, Vec<u8>>::new();
    let (bytes, page) = exchange("read-page", &db, "reserved:astrocyte", json!({}));
    let facts = page["result"]["facts"].as_array().unwrap();
    assert_eq!(facts.len(), 2);
    assert_eq!(facts[0]["workload"], "summary");
    assert_eq!(facts[0]["alfonso"], "agent_7c1e");
    assert_eq!(facts[0]["parent"]["session"], "ses_head1");
    assert_eq!(facts[1]["workload"], "dreamer");
    assert_eq!(facts[1]["parent"], Value::Null);
    assert_eq!(facts[1]["project_id"], "pj-3f9a");
    assert_eq!(page["result"]["next"], Value::Null);
    assert_eq!(page["result"]["through"], "2");
    samples.insert("read-page.json".into(), bytes);

    let (bytes, next) = exchange(
        "read-page-next-empty",
        &db,
        "reserved:astrocyte",
        json!({"after": page["result"]["through"]}),
    );
    assert_eq!(
        next["result"],
        json!({"facts": [], "next": null, "through": "2"})
    );
    samples.insert("read-page-next-empty.json".into(), bytes);

    let (bytes, refused) = exchange("read-refused", &db, "reserved:occipital", json!({}));
    assert_eq!(refused["error"]["code"], "caller_not_admitted");
    samples.insert("read-refused.json".into(), bytes);

    let account = cortexkit_bus_naming::AccountNames::derive(ACCOUNT).unwrap();
    let subject = crate::bus::fact_subject(&account).unwrap();
    let placeholder = subject.replacen(&format!("ck.{ACCOUNT}."), "ck.{acct}.", 1);
    assert_ne!(placeholder, subject, "the account shows as a placeholder");
    let stored = super::tests::rows(&db);
    let body = &stored[0].1;
    let headers = crate::bus::fact_headers(&fact_id(&summary_child), body);
    assert_eq!(
        headers["Ck-Content-Digest"],
        format!("{:x}", Sha256::digest(body.as_bytes()))
    );
    assert_eq!(serde_json::from_str::<Value>(body).unwrap(), facts[0]);
    samples.insert(
        "event.json".into(),
        pretty(&json!({
            "name": "event",
            "subject": placeholder,
            "headers": headers,
            "body": body,
        })),
    );
    assert_eq!(samples.len(), 4);

    let mut root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/mc-attribution-samples-v1");
    let output = std::env::var_os("MC_REGENERATE_ATTRIBUTION_SAMPLES");
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
