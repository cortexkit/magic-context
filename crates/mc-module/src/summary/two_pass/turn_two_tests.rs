use super::*;

fn job(child_harness: &str) -> Job {
    Job {
        owner: SessionRef::new("runner", "pi", "head"),
        project: "project".into(),
        project_root: Some("/project".into()),
        continuation: Continuation {
            child: Child {
                session: SessionRef::new("runner", child_harness, "summary-child"),
                project_root: Some("/project".into()),
            },
            model: ModelRef::new("provider", "model"),
            decision_id: "decision".into(),
            output_tokens: 1_000,
            language: None,
            publication_id: "publication".into(),
        },
        memory_enabled: true,
        auto_promote: true,
        embedding: None,
        authority: None,
    }
}

fn stored(carrier: &Carrier) -> StageRow {
    StageRow {
        session: carrier.owner.clone(),
        harness: carrier.harness.clone(),
        carrier: carrier.name(),
        child: Some(carrier.child.clone()),
        started_at: 0,
        request: json!({"model": carrier.stage_model_json()}),
        reply: None,
    }
}

#[test]
fn turn_two_recovery_preserves_the_child_harness() {
    let carrier = Carrier::of(&job("opencode2"));
    let row = stored(&carrier);
    assert_eq!(row.harness, "pi");
    let recovered = Carrier::from_stage(&row, carrier.project_root.clone()).unwrap();
    assert_eq!(recovered.harness, "pi");
    assert_eq!(
        recovered.child(&recovered.child).session,
        SessionRef::new("runner", "opencode2", "summary-child")
    );
    assert_eq!(recovered.child("check-child").session.harness, "opencode2");
}

#[test]
fn turn_two_recovery_reads_a_persisted_child_harness() {
    let mut row = stored(&Carrier::of(&job("pi")));
    row.request["model"]["childHarness"] = json!("opencode2");
    let recovered = Carrier::from_stage(&row, Some("/project".into())).unwrap();
    assert_eq!(recovered.harness, "pi");
    assert_eq!(
        recovered.child(&recovered.child).session.harness,
        "opencode2"
    );
}

#[test]
fn turn_two_recovery_defaults_legacy_rows_to_the_owner_harness() {
    let mut row = stored(&Carrier::of(&job("pi")));
    row.request["model"]
        .as_object_mut()
        .unwrap()
        .remove("childHarness");
    let recovered = Carrier::from_stage(&row, Some("/project".into())).unwrap();
    assert_eq!(recovered.harness, "pi");
    assert_eq!(recovered.child(&recovered.child).session.harness, "pi");
}

#[test]
fn turn_two_child_harness_does_not_change_check_keys_or_reported_profiles() {
    let same_harness = Carrier::of(&job("pi"));
    let other_harness = Carrier::of(&job("opencode2"));
    let check = Check {
        kind: gates::CheckKind::Disproof,
        operands: vec![gates::Operand {
            id: "memory:1@1:1".into(),
            text: "Ask before pushing.".into(),
        }],
        pairs: Vec::new(),
        input: "Releases need two reviewers.".into(),
    };
    let profile = json!({
        "provider": "provider", "model": "model", "variant": null,
        "decision": "decision", "outputTokens": 1_000, "language": null,
    });
    assert_eq!(same_harness.model_json().to_string(), profile.to_string());
    assert_eq!(other_harness.model_json().to_string(), profile.to_string());
    assert_eq!(
        gates::check_key("decision", &check, &same_harness.model_json()),
        gates::check_key("decision", &check, &other_harness.model_json())
    );
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE memory_stage_attempts (
             stage_key TEXT, reply_json TEXT, reported_profile_json TEXT, state TEXT);
         INSERT INTO memory_stage_attempts(stage_key, state) VALUES ('same', 'sending'), ('other', 'sending');",
    )
    .unwrap();
    let reply = run::Reply {
        text: "reply".into(),
        length_capped: false,
    };
    record_reply(&conn, "same", &same_harness, &reply).unwrap();
    record_reply(&conn, "other", &other_harness, &reply).unwrap();
    let profiles: Vec<String> = conn
        .prepare("SELECT reported_profile_json FROM memory_stage_attempts ORDER BY stage_key")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(profiles, vec![profile.to_string(), profile.to_string()]);
}
