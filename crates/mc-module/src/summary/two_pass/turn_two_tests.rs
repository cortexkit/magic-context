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

#[tokio::test]
async fn session_class_turn_two_and_recovered_stages_omit_label_but_fresh_checks_include_it() {
    use crate::summary::run::session_class_tests::Client;
    let carrier = Carrier::of(&job("opencode2"));
    let row = stored(&carrier);
    let request_before = serde_json::to_vec(&row.request).unwrap();
    let expected_model = json!({
        "provider": "provider", "model": "model", "variant": null,
        "decision": "decision", "outputTokens": 1_000, "language": null,
    });
    let mut expected_stage_model = expected_model.clone();
    expected_stage_model["childHarness"] = json!("opencode2");
    assert_eq!(row.request, json!({"model": expected_stage_model}));
    let model_before = carrier.model_json();
    let check = Check {
        kind: gates::CheckKind::Disproof,
        operands: vec![gates::Operand {
            id: "memory:1@1:1".into(),
            text: "Ask before pushing.".into(),
        }],
        pairs: vec![],
        input: "Releases need two reviewers.".into(),
    };
    let key_before = gates::check_key("decision", &check, &expected_model);
    for declares in [true, false] {
        let client = Client::new(declares);
        carrier
            .send(&client, &carrier.child, "turn-two", "prompt", "system")
            .await
            .unwrap();
        let recovered = Carrier::from_stage(&row, carrier.project_root.clone()).unwrap();
        recovered
            .send(
                &client,
                &recovered.child,
                "stored-stage",
                "prompt",
                "system",
            )
            .await
            .unwrap();
        recovered
            .send(&client, "check-child", "stored-check", "prompt", "system")
            .await
            .unwrap();
        let sends = client.sends.lock().unwrap();
        assert_eq!(sends.len(), 3);
        assert!(sends[..2]
            .iter()
            .all(|(_, request)| request.session_class.is_none()));
        assert_eq!(
            sends[2].1.session_class.as_deref(),
            declares.then_some("summary")
        );
        assert_eq!(serde_json::to_vec(&row.request).unwrap(), request_before);
        assert_eq!(recovered.model_json(), model_before);
        assert_eq!(
            gates::check_key("decision", &check, &recovered.model_json()),
            key_before
        );
        assert!(!String::from_utf8(request_before.clone())
            .unwrap()
            .contains("session_class"));
    }
}

/// A store holding one committed publication with two candidate facts, as a
/// first turn leaves it for its second turn.
fn store_with_candidates() -> (tempfile::TempDir, ContextDb) {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    db.with_connection(|conn| {
        conn.execute_batch(
            "INSERT INTO memory_publications(publication_id, project_path, source_session_id, commit_order, committed_at)
                 VALUES ('publication', 'project', 'head', 1, 0);
             INSERT INTO memory_pending_facts(project_path, publication_id, fact_index, category, content)
                 VALUES ('project', 'publication', 0, 'CONSTRAINTS', 'Releases need two reviewers.'),
                        ('project', 'publication', 1, 'NAMING', 'Crates are named mc-*.');",
        )
    })
    .unwrap();
    (dir, db)
}

/// Each candidate fact's state, attempts and reserving stage.
type FactLedger = Vec<(String, i64, Option<String>)>;

/// Every candidate's state, attempts and reservation, and every second-turn
/// stage's state.
fn ledger(db: &ContextDb) -> (FactLedger, Vec<String>) {
    db.with_connection(|conn| {
        let facts = conn
            .prepare("SELECT state, fact_attempts, reserved_stage_key FROM memory_pending_facts ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let stages = conn
            .prepare("SELECT state FROM memory_stage_attempts WHERE stage = 'turn_two' ORDER BY run_attempt")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        (facts, stages)
    })
}

fn untouched() -> FactLedger {
    vec![("retryable".into(), 0, None), ("retryable".into(), 0, None)]
}

/// The second turn's send meets the account wait, at the send or as the
/// error its run ends with: its stage is revoked, so both facts are
/// retryable again with no attempt spent, and the turn reports the wait.
#[tokio::test]
async fn account_wait_turn_two_revokes_its_stage_without_spending_attempts() {
    use crate::summary::run::account_wait_send_tests::{Answer, Client};
    for answer in [Answer::RefuseSend, Answer::RunEndsRefused] {
        let (_dir, db) = store_with_candidates();
        let client = Client::new(answer);
        let outcome = run(&client, &db, &job("pi")).await;
        let Outcome::AccountWait(wait) = outcome else {
            panic!("not an account wait: {outcome:?}");
        };
        assert_eq!(wait.send, SendKind::TurnTwo);
        assert_eq!(wait.code, "account_limit_exhausted");
        assert_eq!(ledger(&db), (untouched(), vec!["revoked".to_owned()]));
        assert_eq!(*client.sends.lock().unwrap(), 1);
    }
}

/// A send left open by an interrupted second turn is sent again on the next
/// one. When that meets the account wait, the open stage is revoked without
/// counting a recovery visit, and nothing else is sent to the same accounts.
#[tokio::test]
async fn account_wait_recovered_turn_two_is_revoked_without_a_visit() {
    use crate::summary::run::account_wait_send_tests::{Answer, Client};
    let (_dir, db) = store_with_candidates();
    run(&Client::new(Answer::RefuseSend), &db, &job("pi")).await;
    // Put the stage back as a send interrupted before its reply.
    db.with_connection(|conn| {
        conn.execute_batch(
            "UPDATE memory_stage_attempts SET state = 'sending';
             UPDATE memory_pending_facts SET state = 'in_flight',
                 reserved_stage_key = (SELECT stage_key FROM memory_stage_attempts);",
        )
    })
    .unwrap();
    let client = Client::new(Answer::RunEndsRefused);
    let outcome = run(&client, &db, &job("pi")).await;
    assert!(matches!(outcome, Outcome::AccountWait(_)), "{outcome:?}");
    assert_eq!(*client.sends.lock().unwrap(), 1);
    assert_eq!(ledger(&db), (untouched(), vec!["revoked".to_owned()]));
    let request: String = db.with_connection(|conn| {
        conn.query_row(
            "SELECT request_json FROM memory_stage_attempts",
            [],
            |row| row.get(0),
        )
        .unwrap()
    });
    assert!(!request.contains("recoveryVisits"), "{request}");
}

/// A memory fact check that meets the account wait stops the stage instead
/// of counting as a failed check against the memory revision it guards, and
/// leaves no ledger row that says it was sent.
#[tokio::test]
async fn account_wait_fact_check_stops_the_stage_and_forgets_the_check() {
    use crate::summary::run::account_wait_send_tests::{Answer, Client};
    for answer in [Answer::RefuseSend, Answer::RunEndsRefused] {
        let (_dir, db) = store_with_candidates();
        let client = Client::new(answer);
        let resolver = Resolver {
            client: &client,
            db: &db,
            carrier: Carrier::of(&job("pi")),
            memory_enabled: true,
            auto_promote: true,
            authority: None,
        };
        let check = Check {
            kind: gates::CheckKind::Disproof,
            operands: vec![gates::Operand {
                id: "memory:1@1:1".into(),
                text: "Ask before pushing.".into(),
            }],
            pairs: Vec::new(),
            input: "Releases need two reviewers.".into(),
        };
        match resolver.check("decision", &check).await.unwrap() {
            Err(Stopped::AccountWait(wait)) => assert_eq!(wait.send, SendKind::FactCheck),
            Err(Stopped::Unknown) => panic!("an unknown outcome"),
            Ok(verdict) => panic!("judged as {verdict:?}"),
        }
        let checks: i64 = db.with_connection(|conn| {
            conn.query_row("SELECT COUNT(*) FROM memory_check_attempts", [], |row| {
                row.get(0)
            })
            .unwrap()
        });
        assert_eq!(checks, 0);
    }
}

/// A final account-selection refusal is no wait: the second turn fails to
/// send as before, and the attempt is spent.
#[tokio::test]
async fn account_wait_final_refusal_spends_the_turn_two_attempt_as_before() {
    use crate::summary::run::account_wait_send_tests::{Answer, Client};
    for answer in [Answer::RefuseSendFinal, Answer::RunEndsFinal] {
        let (_dir, db) = store_with_candidates();
        let outcome = run(&Client::new(answer), &db, &job("pi")).await;
        assert!(matches!(outcome, Outcome::Failed(_)), "{outcome:?}");
        let (facts, stages) = ledger(&db);
        assert!(
            facts.iter().all(|(_, attempts, _)| *attempts == 1),
            "{facts:?}"
        );
        assert_eq!(stages, vec!["transport_failed".to_owned()]);
    }
}

/// The plugin hosts count an item's sends from the same table with their
/// own query (`ITEM_SENDS` in `turn-two-scoring.ts`). A stage revoked for an
/// account wait must count for neither side, or an item one side still
/// offers is retired by the other.
#[tokio::test]
async fn account_wait_revoked_stage_counts_no_item_send_on_either_side() {
    use crate::summary::run::account_wait_send_tests::{Answer, Client};
    const PLUGIN: &str = include_str!(
        "../../../../../packages/plugin/src/features/magic-context/memory/turn-two-scoring.ts"
    );
    let start = PLUGIN
        .find("const ITEM_SENDS = `")
        .expect("the plugin's ITEM_SENDS")
        + 20;
    let plugin_sends = &PLUGIN[start..start + PLUGIN[start..].find('`').unwrap()];
    let (_dir, db) = store_with_candidates();
    db.with_connection(|conn| {
        conn.execute_batch(
            "INSERT INTO memories(id, project_path, category, content, normalized_hash,
                                  first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES (1, 'project', 'CONSTRAINTS', 'Releases need two reviewers.', 'hash', 0, 0, 0, 0);
             INSERT INTO memory_classification_items(project_path, memory_id, saved_revision,
                     source_session_id, tool_call_part_id, save_ordinal, excerpt)
                 VALUES ('project', 1, 1, 'head', 'call', 1, 'The person said releases need two reviewers.');",
        )
    })
    .unwrap();
    let outcome = run(&Client::new(Answer::RefuseSend), &db, &job("pi")).await;
    assert!(matches!(outcome, Outcome::AccountWait(_)), "{outcome:?}");
    db.with_connection(|conn| {
        let held: String = conn
            .query_row(
                "SELECT request_json FROM memory_stage_attempts",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(held.contains("\"itemsHeldForAccount\":["), "{held}");
        for sends in [ITEM_SENDS, plugin_sends] {
            let counted: i64 = conn
                .query_row(
                    &format!("SELECT {sends} FROM memory_classification_items i"),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(counted, 0, "{sends}");
        }
    });
}

/// A runner may pause the second turn's run for an account limit. Still
/// paused when the turn's time runs out, with the limit's run error beside
/// the pause, it is an account wait like any other: the stage is revoked
/// and no attempt is spent. The paused clock lets the turn's twenty-minute
/// deadline pass at once.
#[tokio::test(start_paused = true)]
async fn account_wait_turn_two_paused_for_an_account_revokes_its_stage() {
    use crate::summary::run::account_wait_send_tests::{Answer, Client};
    let (_dir, db) = store_with_candidates();
    let outcome = run(&Client::new(Answer::PausedForAccount), &db, &job("pi")).await;
    let Outcome::AccountWait(wait) = outcome else {
        panic!("not an account wait: {outcome:?}");
    };
    assert_eq!(wait.send, SendKind::TurnTwo);
    assert_eq!(ledger(&db), (untouched(), vec!["revoked".to_owned()]));
}
