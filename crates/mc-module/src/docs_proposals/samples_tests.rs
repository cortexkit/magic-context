//! The tagged sample set `mc-docs-proposal-samples-v1`: what a flow sees of
//! a docs-upkeep proposal on the wire. The notice ck-mc publishes when a
//! proposal is made (its subject and every header the bus carries), the
//! `events_get` reply for one proposal in each state (the body is the string
//! stored when the proposal was made, the same in each), the matching
//! `docs_proposals.state` replies, and the `event_not_visible` refusal for a
//! key ck-mc never published. Each state is a fresh fixture store and
//! checkout holding the same proposal, brought to that state the way it
//! happens for real: the documents edited some other way (stale), the
//! proposal's result written by hand (applied), the person's dismiss
//! (dismissed).
//!
//! Regenerate deliberately from the workspace root:
//! `MC_REGENERATE_DOCS_PROPOSAL_SAMPLES=1 cargo test --locked -p mc-module
//! --lib docs_proposals::samples_tests::samples_v1 -- --exact`. Set the
//! variable to an output directory instead of `1` for a read-only checkout.

use std::collections::BTreeMap;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::tests::{apply_by_hand, proposed};
use super::*;
use crate::dreamer::tasks::maintain_docs::tests::{Fixture, PROJECT};

/// The time every proposal's notice was published, fixed so the replies
/// don't change from run to run.
const PUBLISHED_AT: i64 = 1_700_000_060_000;
/// The bus account the notice's subject names: a placeholder.
const ACCOUNT: &str = "box_test";

fn pretty(value: &Value) -> Vec<u8> {
    format!("{}\n", serde_json::to_string_pretty(value).unwrap()).into_bytes()
}

/// One request and its reply on the management surface, as a flow's route
/// carries them: `{"result": ...}`, or the refusal's body.
fn exchange(name: &str, db: &ContextDb, request: Value) -> (Vec<u8>, Value) {
    let response = match flow::handle(Some(db), &request) {
        Ok(reply) => reply,
        Err(refusal) => json!({"error": refusal}),
    };
    let bytes = pretty(&json!({"name": name, "request": request, "response": response}));
    (bytes, response)
}

/// A fixture holding the one proposal, its notice published, in `state`.
fn in_state(state: &str) -> (Fixture, i64) {
    let (fixture, id) = proposed();
    fixture
        .db
        .with_connection(|conn| mark_published(conn, id, PUBLISHED_AT))
        .unwrap();
    match state {
        PENDING => {}
        STALE => fixture
            .repo
            .write(&[("STRUCTURE.md", "# Structure\n\nEdited by hand.\n")]),
        APPLIED => apply_by_hand(&fixture),
        "dismissed" => fixture.db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            assert!(dismiss(&tx, id, PUBLISHED_AT + 60_000).unwrap());
            tx.commit().unwrap();
        }),
        other => panic!("no state {other}"),
    }
    (fixture, id)
}

#[test]
fn samples_v1() {
    let mut samples = BTreeMap::<String, Vec<u8>>::new();
    let mut bodies = Vec::new();
    let mut digest = None;
    for state in [PENDING, STALE, APPLIED, "dismissed"] {
        let (fixture, id) = in_state(state);
        let key = event_key(PROJECT, id);
        if state == PENDING {
            let account = cortexkit_bus_naming::AccountNames::derive(ACCOUNT).unwrap();
            let notice = crate::bus::notice(&account, &fixture.proposal(id)).unwrap();
            // Every header the bus carries: its own two (the message id and
            // the content digest, which it writes as bare hex) and the ones
            // the event's declaration lists. The body is empty.
            let mut headers = json!({
                "Nats-Msg-Id": notice.id,
                "Ck-Content-Digest": notice.digest.to_string(),
            });
            for (name, value) in &notice.headers {
                headers[name] = json!(value);
            }
            digest = Some(notice.digest.to_string());
            samples.insert(
                "notice.json".into(),
                pretty(&json!({
                    "name": "notice",
                    "subject": notice.subject,
                    "headers": headers,
                    "body": "",
                })),
            );
        }
        let (bytes, reply) = exchange(
            &format!("state-{state}"),
            &fixture.db,
            json!({"method": flow::STATE, "params": {"proposal_id": id}}),
        );
        assert_eq!(reply["result"]["state"], state);
        samples.insert(format!("state-{state}.json"), bytes);
        let (bytes, reply) = exchange(
            &format!("events-get-{state}"),
            &fixture.db,
            json!({"method": flow::EVENTS_GET, "params": {
                "event_key": key, "event_name": EVENT_NAME, "version": EVENT_VERSION,
            }}),
        );
        let result = &reply["result"];
        assert_eq!(result["published_at"], PUBLISHED_AT);
        assert_eq!(
            result["digest"].as_str(),
            Some(sha256(result["body"].as_str().unwrap().as_bytes()).as_str())
        );
        bodies.push((result["body"].clone(), result["digest"].clone()));
        samples.insert(format!("events-get-{state}.json"), bytes);
        if state == PENDING {
            let (bytes, reply) = exchange(
                "events-get-unknown-key",
                &fixture.db,
                json!({"method": flow::EVENTS_GET, "params": {
                    "event_key": format!("{PROJECT}:999"), "event_name": EVENT_NAME, "version": EVENT_VERSION,
                }}),
            );
            assert_eq!(reply["error"]["code"], "event_not_visible");
            samples.insert("events-get-unknown-key.json".into(), bytes);
        }
    }
    // One body for every state, as stored when the proposal was made, and
    // the digest the notice carried.
    assert!(bodies.windows(2).all(|pair| pair[0] == pair[1]));
    assert_eq!(bodies[0].1.as_str(), digest.as_deref());
    let body: Value = serde_json::from_str(bodies[0].0.as_str().unwrap()).unwrap();
    assert_eq!(body["status"], PENDING);
    assert_eq!(body["file"], file::relative(1));
    assert_eq!(samples.len(), 10);

    let mut root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata/mc-docs-proposal-samples-v1");
    let output = std::env::var_os("MC_REGENERATE_DOCS_PROPOSAL_SAMPLES");
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
