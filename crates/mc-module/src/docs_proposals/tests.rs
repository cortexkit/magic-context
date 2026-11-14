//! Proposals as their readers see them: the app read, the two flow
//! operations, and the status every read checks.

use serde_json::{json, Value};

use super::*;
use crate::dreamer::tasks::maintain_docs::tests::{
    changed, replacement, Fixture, ARCHITECTURE, PROJECT,
};

/// A fixture with one pending proposal, and its id.
pub(crate) fn proposed() -> (Fixture, i64) {
    let fixture = Fixture::documented();
    changed(&fixture);
    let batch = fixture.batch();
    fixture.apply(&batch, &replacement());
    let id = fixture.pending().unwrap().id;
    (fixture, id)
}

/// Write the proposal's result, as a person or agent applying it does.
pub(crate) fn apply_by_hand(fixture: &Fixture) {
    fixture.repo.write(&[(
        "ARCHITECTURE.md",
        &ARCHITECTURE.replace(
            "The parser lives in src/parser.rs.",
            "The parser lives in src/parse/ now.",
        ),
    )]);
}

#[test]
fn a_status_follows_the_documents_hashes() {
    let (fixture, id) = proposed();
    let proposal = fixture.proposal(id);
    assert_eq!(judged(&proposal, &proposal.base), PENDING);
    assert_eq!(judged(&proposal, &proposal.result), APPLIED);
    assert_eq!(judged(&proposal, &[None, proposal.base[1].clone()]), STALE);
    assert_eq!(
        judged(&proposal, &[proposal.result[0].clone(), None]),
        STALE
    );
    // A checkout that is gone shows nothing: the proposal stays as it is.
    let mut gone = proposal.clone();
    gone.checkout = "/nonexistent/checkout".into();
    assert_eq!(refresh(&fixture.db, gone).unwrap().status, PENDING);
}

#[test]
fn the_app_read_shows_the_pending_proposal_and_then_nothing_once_applied() {
    let (fixture, id) = proposed();
    let params = json!({"project": PROJECT});
    let read = crate::app_read::docs::read(Some(&fixture.db), true, &params).unwrap();
    let proposal = &read["proposal"];
    assert_eq!(proposal["id"], id);
    assert_eq!(proposal["status"], "pending");
    assert_eq!(proposal["created_at_ms"], 1_700_000_000_000_i64);
    assert_eq!(proposal["documents"][0]["name"], "ARCHITECTURE.md");
    assert!(proposal["documents"][0]["diff"]
        .as_str()
        .unwrap()
        .contains("+The parser lives in src/parse/ now."));
    assert_eq!(
        proposal["documents"][0]["changes"],
        json!([{"action": "replace", "heading": "## Core", "reason": "src/parser.rs moved to src/parse/."}])
    );
    assert_eq!(proposal["dropped"], json!([]));
    assert_eq!(read["op"], "dreamer.docs_proposal");
    apply_by_hand(&fixture);
    let read = crate::app_read::docs::read(Some(&fixture.db), true, &params).unwrap();
    assert_eq!(read["proposal"], Value::Null);
    assert_eq!(fixture.proposal(id).status, APPLIED);
}

#[test]
fn the_app_read_refuses_an_unknown_project_and_unknown_fields() {
    let (fixture, _) = proposed();
    let refusal =
        crate::app_read::docs::read(Some(&fixture.db), false, &json!({"project": PROJECT}))
            .unwrap_err();
    assert_eq!(refusal.code, "project_unknown");
    let refusal = crate::app_read::docs::read(
        Some(&fixture.db),
        true,
        &json!({"project": PROJECT, "extra": 1}),
    )
    .unwrap_err();
    assert_eq!(refusal.code, "invalid_params");
    let read = crate::app_read::docs::read(Some(&fixture.db), true, &json!({"project": "pj-none"}))
        .unwrap();
    assert_eq!(read["proposal"], Value::Null);
}

fn events_get(fixture: &Fixture, params: Value) -> Result<Value, subc_protocol::ErrorBody> {
    flow::handle(
        Some(&fixture.db),
        &json!({"method": "events_get", "params": params}),
    )
}

fn state(fixture: &Fixture, id: i64) -> String {
    flow::handle(
        Some(&fixture.db),
        &json!({"method": "docs_proposals.state", "params": {"proposal_id": id}}),
    )
    .unwrap()["result"]["state"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn events_get_serves_the_stored_body_in_every_state() {
    let (fixture, id) = proposed();
    let key = format!("{PROJECT}:{id}");
    let params = json!({"event_key": key, "event_name": "docs_proposal", "version": 1});
    let stored = fixture.proposal(id).body;
    let first = events_get(&fixture, params.clone()).unwrap();
    let reply = &first["result"];
    assert_eq!(reply["body"], stored.as_str());
    assert_eq!(reply["digest"], sha256(stored.as_bytes()));
    assert_eq!(reply["event_key"], key.as_str());
    assert_eq!(reply["event_name"], "docs_proposal");
    assert_eq!(reply["published_at"], Value::Null);
    let body: Value = serde_json::from_str(reply["body"].as_str().unwrap()).unwrap();
    assert_eq!(body["project_id"], PROJECT);
    assert_eq!(state(&fixture, id), "pending");
    // Applied: the state says so, and the body is the same bytes.
    apply_by_hand(&fixture);
    assert_eq!(state(&fixture, id), "applied");
    assert_eq!(events_get(&fixture, params.clone()).unwrap(), first);
    // Published: the time shows.
    fixture
        .db
        .with_connection(|conn| mark_published(conn, id, 42))
        .unwrap();
    assert_eq!(
        events_get(&fixture, params).unwrap()["result"]["published_at"],
        42
    );
}

#[test]
fn events_get_refuses_an_unknown_key_name_or_version_alike() {
    let (fixture, id) = proposed();
    let key = format!("{PROJECT}:{id}");
    for params in [
        json!({"event_key": format!("{PROJECT}:999"), "event_name": "docs_proposal", "version": 1}),
        json!({"event_key": format!("pj-other:{id}"), "event_name": "docs_proposal", "version": 1}),
        json!({"event_key": "no-colon", "event_name": "docs_proposal", "version": 1}),
        json!({"event_key": key, "event_name": "review_findings", "version": 1}),
        json!({"event_key": key, "event_name": "docs_proposal", "version": 2}),
    ] {
        let refusal = events_get(&fixture, params.clone()).unwrap_err();
        assert_eq!(refusal.code, "event_not_visible", "{params}");
    }
    let refusal = events_get(&fixture, json!({"event_key": key})).unwrap_err();
    assert_eq!(refusal.code, "invalid_params");
    let refusal = flow::handle(
        Some(&fixture.db),
        &json!({"method": "docs_proposals.state", "params": {"proposal_id": 999}}),
    )
    .unwrap_err();
    assert_eq!(refusal.code, "event_not_visible");
}

#[test]
fn a_dismissed_or_stale_proposal_keeps_its_body_and_says_its_state() {
    let (fixture, id) = proposed();
    fixture.db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        assert!(dismiss(&tx, id, 5).unwrap());
        assert!(!dismiss(&tx, id, 6).unwrap(), "only a pending one");
        tx.commit().unwrap();
    });
    assert_eq!(state(&fixture, id), "dismissed");
    let (fixture, id) = proposed();
    fixture
        .repo
        .write(&[("STRUCTURE.md", "# Structure\n\nOther.\n")]);
    assert_eq!(state(&fixture, id), "stale");
    assert!(!file::path(fixture.repo.path(), id).exists());
}
