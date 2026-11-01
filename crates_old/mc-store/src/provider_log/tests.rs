use super::*;
use crate::{open_sqlite, register_legacy_trigger_functions, MIGRATIONS, NS};
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

fn descriptor(dir: &std::path::Path) -> StorageDescriptor {
    StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: NS.into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into_owned(),
        },
    }
}
fn key() -> ProviderSessionKey {
    ProviderSessionKey {
        generation: None,
        project_root: "/project".into(),
        session: "session".into(),
        harness: "opencode".into(),
    }
}
fn store(dir: &std::path::Path) -> McStore {
    let store = McStore::open_for_test(&descriptor(dir)).unwrap();
    store
        .save_provider_conversation(
            &key(),
            &ProviderConversation {
                engine_namespace: "engine".into(),
                params_json: "{}".into(),
                hook_counters_json: "{}".into(),
                historian_model_chain_json: "[]".into(),
                ..Default::default()
            },
        )
        .unwrap();
    store
}
fn lineage(id: &str, first: u64) -> ProviderLineage {
    ProviderLineage {
        lineage_id: id.into(),
        first_ordinal: first,
        descends_from: None,
        through_ordinal: None,
    }
}
fn message(ordinal: u64) -> ProviderMessage {
    ProviderMessage {
        ordinal,
        mid: format!("m{ordinal}"),
        message_bytes: format!("{{ \"text\" : \"résumé \\u0061\", \"n\": {ordinal} }}")
            .into_bytes(),
    }
}
fn subject(mid: &str, part: &str) -> ProviderSubject {
    ProviderSubject {
        subject_mid: mid.into(),
        hook: "post_tool".into(),
        subject_part: part.into(),
    }
}
fn hook(
    store: &McStore,
    l: &ProviderLineage,
    m: &ProviderMessage,
    part: &str,
    served: Option<u64>,
    repeat: bool,
) -> i64 {
    let s = subject(&m.mid, part);
    store
        .commit_provider_hook(
            &key(),
            ProviderHookRequest {
                lineage: l,
                message: Some(m),
                served_through_ordinal: served,
                unserved_subjects: &[],
                repeat_subject: repeat.then_some(&s),
            },
            |ctx| {
                let number = ctx.tag_high_water + 1;
                Ok((
                    ProviderHookWrite {
                        answer: Some(ProviderHookAnswer {
                            subject: s.clone(),
                            ordinal: m.ordinal,
                            ops_json: "[]".into(),
                            tags: vec![ProviderAnswerTag {
                                number,
                                block_id: format!("{}#{part}", m.mid),
                                kind: "tool_result".into(),
                                source: "payload".into(),
                                token_count: 2,
                                created_at_ms: 10,
                            }],
                        }),
                        counters: ctx.counters.clone(),
                        policy_summary: None,
                    },
                    number,
                ))
            },
        )
        .unwrap()
}

#[test]
fn v65_blob_round_trips_messages_answers_pending_drops_and_empty_lineages() {
    // The undeployed OpenCode projection is reset at the recipe cutover; generic
    // runner observations must still migrate losslessly through every version.
    // A runner record that stored whole views in mc_provider_views_v1 (an
    // unreleased development table) is reset when migration 73 retires it.
    let native_key = key();
    let key = || ProviderSessionKey {
        harness: "broca".into(),
        ..native_key.clone()
    };
    let dir = tempfile::tempdir().unwrap();
    let descriptor = descriptor(dir.path());
    let inner = open_sqlite(&descriptor).unwrap();
    inner.with_conn(register_legacy_trigger_functions).unwrap();
    let previous: Vec<_> = MIGRATIONS
        .iter()
        .filter(|migration| migration.version < 66)
        .cloned()
        .collect();
    inner.migrate(NS, &previous).unwrap();
    let view = |v: u64| json!({"compaction_id":"c","version":v,"range":{"lineage_id":"L","from":4000,"to":4001},"replacement":[{"content":"frozen"}]});
    let record = json!({
        "catalog":{"compacting":true,"tools":["ctx_reduce"]},
        "setup":{"request":{"lineage_id":"L","params":{"serializer_profile":"owned-broca"}},"state":{"compaction_id":"c","preset":"head","version_high_water":9,"rebuild_epoch":2,"last_produced":view(9),"last_applied":view(8)},"stability":[{"index":0,"rank":2}],"call_when":{"usage":0.7}},
        "hook":{"high_water":12,"answers":[{"subject":"digest","lineage":"L","answer":{"ops":[{"op":"prepend","text":"§12§ "}]},"rendered":["§12§ payload"],"tags":[12],"cadence":true,"observed":false,"tool_call_id":"repeat"},{"subject":"seen","lineage":null,"answer":"pass","rendered":[],"tags":[],"cadence":false,"observed":true,"tool_call_id":null}],"live":{"10":{"lineage":"L","ordinal":4000,"block_id":"m4000#0","kind":"text","source":"payload"}},"burned":[11],"observed_tools":6,"last_reminder_at":5,"observed_users":2,"last_nudge_at":null},
        "messages":{"L":{"4000":{"ordinal":4000,"mid":"m4000","message":{"role":"user","content":[{"type":"text","text":"résumé"}]}}},"empty":{}},
        "pending_drops":[10,12],"last_answer":{"request_id":"r","answer":"noop"},"wait_request":"wait","wait_view":view(7),"future_field":{"keep":true}
    });
    let viewed_key = ProviderSessionKey {
        session: "viewed".into(),
        ..key()
    };
    let viewed = record.clone();
    let mut record = record;
    record["setup"]["state"]
        .as_object_mut()
        .unwrap()
        .remove("last_produced");
    record["setup"]["state"]
        .as_object_mut()
        .unwrap()
        .remove("last_applied");
    record.as_object_mut().unwrap().remove("wait_view");
    inner
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO mc_provider_sessions_v1 VALUES (?1,?2,?3,?4)",
                params![
                    key().project_root,
                    key().session,
                    key().harness,
                    record.to_string()
                ],
            )?;
            conn.execute(
                "INSERT INTO mc_provider_sessions_v1 VALUES (?1,?2,?3,?4)",
                params![
                    viewed_key.project_root,
                    viewed_key.session,
                    viewed_key.harness,
                    viewed.to_string()
                ],
            )?;
            conn.execute(
                "INSERT INTO mc_provider_sessions_v1 VALUES (?1,?2,?3,?4)",
                params![
                    native_key.project_root,
                    native_key.session,
                    native_key.harness,
                    record.to_string()
                ],
            )?;
            Ok(())
        })
        .unwrap();
    drop(inner);
    let store = McStore::open_for_test(&descriptor).unwrap();
    assert!(store.load_provider_record(&native_key).unwrap().is_none());
    assert!(store
        .load_provider_conversation(&native_key)
        .unwrap()
        .is_none());
    assert!(store.load_provider_record(&viewed_key).unwrap().is_none());
    assert!(store
        .load_provider_conversation(&viewed_key)
        .unwrap()
        .is_none());
    assert_eq!(
        serde_json::from_str::<Value>(&store.load_provider_record(&key()).unwrap().unwrap())
            .unwrap(),
        record
    );
    let c = store.load_provider_conversation(&key()).unwrap().unwrap();
    assert!(c.engine_namespace.starts_with("mc-provider:"));
    assert_eq!(c.version_high_water, 9);
    store
        .inner
        .with_conn(|conn| {
            let policies: Vec<String> = conn
                .prepare("SELECT policy_json FROM mc_provider_hook_answers_v1 WHERE conv_key=?1")?
                .query_map([key().conversation_key()], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            assert_eq!(policies, vec!["{}".to_string(); 2]);
            Ok(())
        })
        .unwrap();
    assert_eq!(store.provider_frontier(&key(), "L").unwrap(), 4001);
    store
        .save_provider_record(&key(), &record.to_string(), &c.engine_namespace, &[], &[])
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&store.load_provider_record(&key()).unwrap().unwrap())
            .unwrap(),
        record
    );
    drop(store);
    let reopened = McStore::open_for_test(&descriptor).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&reopened.load_provider_record(&key()).unwrap().unwrap())
            .unwrap(),
        record
    );
    reopened
        .inner
        .with_conn(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT record FROM mc_provider_sessions_v1 WHERE session='session'",
                    [],
                    |r| r.get::<_, String>(0)
                )?,
                record.to_string()
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn message_bytes_are_verbatim_and_conflicts_refuse_without_partial_writes() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 4000);
    let m = message(4000);
    store
        .commit_provider_status(&key(), &l, std::slice::from_ref(&m), None, &[])
        .unwrap();
    store
        .commit_provider_status(&key(), &l, std::slice::from_ref(&m), None, &[])
        .unwrap();
    assert_eq!(
        store.load_provider_messages(&key(), "L").unwrap(),
        vec![m.clone()]
    );
    let mut different = m.clone();
    different.message_bytes =
        serde_json::to_vec(&serde_json::from_slice::<Value>(&m.message_bytes).unwrap()).unwrap();
    assert!(
        matches!(store.commit_provider_status(&key(),&l,&[different],None,&[]),Err(ProviderError::Transient(reason)) if reason=="an ingested ordinal changed")
    );
    let mut different = m.clone();
    different.mid = "other".into();
    assert!(matches!(
        store.commit_provider_status(&key(), &l, &[message(4001), different], None, &[]),
        Err(ProviderError::InvalidParams {
            field: "subject_ordinal"
        })
    ));
    let mut different = m.clone();
    different.ordinal = 4001;
    assert!(matches!(
        store.commit_provider_status(&key(), &l, &[different], None, &[]),
        Err(ProviderError::InvalidParams {
            field: "subject_mid"
        })
    ));
    assert_eq!(store.load_provider_messages(&key(), "L").unwrap(), vec![m]);
}

#[test]
fn absolute_frontier_is_complete_at_4010_and_reports_a_real_hole() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 4000);
    let entries = (4000..=4010)
        .filter(|n| *n != 4005)
        .map(message)
        .collect::<Vec<_>>();
    store
        .commit_provider_status(&key(), &l, &entries, None, &[])
        .unwrap();
    assert_eq!(store.provider_frontier(&key(), "L").unwrap(), 4005);
    store
        .commit_provider_status(&key(), &l, &[message(4005)], None, &[])
        .unwrap();
    assert_eq!(store.provider_frontier(&key(), "L").unwrap(), 4011);
}

#[test]
fn pending_answers_promote_only_after_confirmation_and_retries_burn_only_one_part() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 0);
    let m = message(0);
    let first = hook(&store, &l, &m, "p1", None, false);
    let second = hook(&store, &l, &m, "p2", None, false);
    assert!(store.load_tags_for_session("engine").unwrap().is_empty());
    store
        .queue_provider_drops(&key(), &[first, second])
        .unwrap();
    let third = hook(&store, &l, &m, "p1", None, true);
    assert_eq!(
        store.load_provider_pending_drops(&key()).unwrap(),
        vec![second]
    );
    assert!(store.queue_provider_drops(&key(), &[first]).is_err());
    store
        .commit_provider_status(&key(), &l, &[], Some(0), &[])
        .unwrap();
    let numbers = store
        .load_tags_for_session("engine")
        .unwrap()
        .iter()
        .map(|t| t.tag_number)
        .collect::<Vec<_>>();
    assert_eq!(numbers, vec![second, third]);
    assert_eq!(
        store
            .load_provider_hook_answers(&key())
            .unwrap()
            .iter()
            .map(|a| a.state.as_str())
            .collect::<Vec<_>>(),
        vec!["burned", "live", "live"]
    );
}

#[test]
fn conflicting_status_refuses_before_promote_and_burn() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 0);
    let m = message(0);
    hook(&store, &l, &m, "p1", None, false);
    let mut conflict = m.clone();
    conflict.mid = "other".into();
    assert!(store
        .commit_provider_status(&key(), &l, &[conflict], Some(0), &[subject(&m.mid, "p1")])
        .is_err());
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[0].state,
        "pending"
    );
    assert!(store.load_tags_for_session("engine").unwrap().is_empty());
}

#[test]
fn final_status_gap_rolls_back_admission_and_acknowledgement_in_the_conflict_fence() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 1);
    hook(&store, &l, &message(1), "p1", None, false);
    let before = serde_json::to_value(store.load_provider_conversation(&key()).unwrap()).unwrap();
    assert_eq!(
        store
            .commit_provider_status_page(
                &key(),
                ProviderStatusPage {
                    lineage: &l,
                    messages: &[message(3)],
                    served: Some(3),
                    unserved: &[subject("m1", "p1")],
                    newest: Some(3),
                    more: false
                }
            )
            .unwrap(),
        Some(2)
    );
    assert_eq!(
        store.load_provider_messages(&key(), "L").unwrap(),
        vec![message(1)]
    );
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[0].state,
        "pending"
    );
    assert!(store.load_tags_for_session("engine").unwrap().is_empty());
    assert_eq!(
        serde_json::to_value(store.load_provider_conversation(&key()).unwrap()).unwrap(),
        before
    );
    let mut conflict = message(1);
    conflict.mid = "other".into();
    assert!(matches!(
        store.commit_provider_status_page(
            &key(),
            ProviderStatusPage {
                lineage: &l,
                messages: &[message(3), conflict],
                served: Some(3),
                unserved: &[],
                newest: Some(3),
                more: false
            }
        ),
        Err(ProviderError::InvalidParams {
            field: "subject_ordinal"
        })
    ));
    assert_eq!(
        store.load_provider_messages(&key(), "L").unwrap(),
        vec![message(1)]
    );
}

#[test]
fn acknowledgements_are_bounded_monotone_and_missing_never_promotes() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 4000);
    hook(&store, &l, &message(4000), "p", None, false);
    assert!(matches!(
        store.commit_provider_status(&key(), &l, &[], Some(4001), &[]),
        Err(ProviderError::InvalidParams {
            field: "served_through_ordinal"
        })
    ));
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[0].state,
        "pending"
    );
    store
        .commit_provider_status(&key(), &l, &[], Some(4000), &[])
        .unwrap();
    hook(&store, &l, &message(4001), "p", None, false);
    assert_eq!(
        store
            .load_provider_conversation(&key())
            .unwrap()
            .unwrap()
            .served_through_ordinal,
        Some(4000)
    );
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[1].state,
        "pending"
    );
    assert!(matches!(
        store.commit_provider_status(&key(), &l, &[], Some(3999), &[subject("m4001", "p")]),
        Err(ProviderError::InvalidParams {
            field: "served_through_ordinal"
        })
    ));
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[1].state,
        "pending"
    );
    assert_eq!(store.load_tags_for_session("engine").unwrap().len(), 1);
}

#[test]
fn acknowledgement_decreases_only_in_the_transaction_creating_a_descent() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let root = lineage("L", 4000);
    store
        .commit_provider_status(
            &key(),
            &root,
            &[message(4000), message(4001), message(4002)],
            Some(4002),
            &[],
        )
        .unwrap();
    let child = ProviderLineage {
        lineage_id: "child".into(),
        first_ordinal: 4001,
        descends_from: Some("L".into()),
        through_ordinal: Some(4000),
    };
    store
        .commit_provider_status(&key(), &child, &[], Some(4000), &[])
        .unwrap();
    assert_eq!(
        store
            .load_provider_conversation(&key())
            .unwrap()
            .unwrap()
            .served_through_ordinal,
        Some(4000)
    );
    store
        .commit_provider_status(&key(), &child, &[message(4001)], Some(4001), &[])
        .unwrap();
    assert!(matches!(
        store.commit_provider_status(&key(), &child, &[], Some(4000), &[]),
        Err(ProviderError::InvalidParams {
            field: "served_through_ordinal"
        })
    ));
}

/// A synthetic-only recipe: the immutable content is its metadata and head slot.
fn frozen_recipe(version: u64, text: &str) -> crate::ProviderViewRecipe {
    crate::ProviderViewRecipe {
        version,
        lineage_id: "L".into(),
        range_from: 4000,
        range_to: 4001,
        base_version: None,
        policy_cut_id: None,
        metadata: serde_json::json!({"text": text}),
        segments: vec![crate::ProviderViewSegment::Synthetic {
            slot: "head".into(),
        }],
        synthetic: BTreeMap::from([("head".into(), serde_json::json!({"text": text}))]),
        treatments: vec![],
        serializer_profile: "owned-broca".into(),
        render_key: "fixture-render".into(),
        tokenizer_key: "fixture-tokenizer".into(),
        state: "produced".into(),
    }
}

fn recipe_state(store: &McStore, version: u64) -> (String, String) {
    store
        .inner
        .with_conn(|conn| {
            conn.query_row(
                "SELECT state,view_meta_json FROM mc_provider_views_v2 WHERE conv_key=?1 AND version=?2",
                params![key().conversation_key(), version],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap()
}

#[test]
fn view_state_changes_only_state_and_refuses_missing_or_illegal_transitions() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    store
        .save_provider_view_recipe(&key(), &frozen_recipe(7, "résumé \\u0061"))
        .unwrap();
    let (_, metadata) = recipe_state(&store, 7);
    for state in ["applied", "applied", "not_applied", "not_applied"] {
        store.set_provider_view_state(&key(), 7, state).unwrap();
        assert_eq!(
            recipe_state(&store, 7),
            (state.to_string(), metadata.clone())
        );
    }
    assert!(store
        .set_provider_view_state(&key(), 7, "produced")
        .unwrap_err()
        .to_string()
        .contains("state"));
    assert!(store
        .set_provider_view_state(&key(), 7, "applied")
        .unwrap_err()
        .to_string()
        .contains("state"));
    assert!(store
        .set_provider_view_state(&key(), 8, "applied")
        .unwrap_err()
        .to_string()
        .contains("version"));
    assert_eq!(recipe_state(&store, 7).1, metadata);
}

#[test]
fn descent_shares_prefix_without_copying_and_burns_module_ahead_allocations() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 4000);
    let a = hook(&store, &l, &message(4000), "p1", None, false);
    let b = hook(&store, &l, &message(4001), "p2", None, false);
    store.queue_provider_drops(&key(), &[a, b]).unwrap();
    let child = ProviderLineage {
        lineage_id: "child".into(),
        first_ordinal: 4001,
        descends_from: Some("L".into()),
        through_ordinal: Some(4000),
    };
    let mut m = message(4001);
    m.mid = "replacement".into();
    hook(&store, &child, &m, "p3", Some(4000), false);
    assert_eq!(
        store.load_provider_messages(&key(), "child").unwrap(),
        vec![message(4000), m]
    );
    assert_eq!(store.provider_frontier(&key(), "child").unwrap(), 4002);
    assert_eq!(
        store
            .load_tags_for_session("engine")
            .unwrap()
            .iter()
            .map(|t| t.tag_number)
            .collect::<Vec<_>>(),
        vec![a]
    );
    assert_eq!(store.load_provider_pending_drops(&key()).unwrap(), vec![a]);
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[1].state,
        "burned"
    );
    store
        .inner
        .with_conn(|conn| {
            assert_eq!(
                conn.query_row("SELECT count(*) FROM mc_provider_messages_v1", [], |r| r
                    .get::<_, i64>(0))?,
                3
            );
            Ok(())
        })
        .unwrap();
    let bad = ProviderLineage {
        lineage_id: "bad".into(),
        first_ordinal: 4011,
        descends_from: Some("child".into()),
        through_ordinal: Some(4010),
    };
    assert!(store
        .commit_provider_status(&key(), &bad, &[], Some(4010), &[])
        .is_err());
}

#[test]
fn failed_counter_write_rolls_back_ingest_promotion_answer_and_tags() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 0);
    hook(&store, &l, &message(0), "p1", None, false);
    store.inner.with_conn(|conn|conn.execute_batch("CREATE TEMP TRIGGER fail_counter BEFORE UPDATE OF hook_counters_json ON mc_provider_conversations_v2 BEGIN SELECT RAISE(ABORT,'counter failure'); END;")).unwrap();
    assert!(store
        .commit_provider_status(&key(), &l, &[message(1)], Some(0), &[])
        .is_err());
    assert_eq!(
        store.load_provider_messages(&key(), "L").unwrap(),
        vec![message(0)]
    );
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[0].state,
        "pending"
    );
    assert!(store.load_tags_for_session("engine").unwrap().is_empty());
}

#[test]
fn hook_path_writes_one_transaction_without_blob_rewrite() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 0);
    store.inner.with_conn(|conn| {
        // Counter triggers observe the actual tables, including rollback blobs;
        // they cannot pass merely because a preferred API was not called.
        conn.execute("INSERT INTO mc_provider_sessions_v1 VALUES ('/project','session','opencode','{}')",[])?;
        conn.execute_batch("CREATE TEMP TABLE hook_writes(kind TEXT);
            CREATE TEMP TRIGGER count_message AFTER INSERT ON mc_provider_messages_v1 BEGIN INSERT INTO hook_writes VALUES ('message'); END;
            CREATE TEMP TRIGGER count_message_rewrite AFTER UPDATE ON mc_provider_messages_v1 BEGIN INSERT INTO hook_writes VALUES ('rewrite'); END;
            CREATE TEMP TRIGGER count_answer AFTER INSERT ON mc_provider_hook_answers_v1 BEGIN INSERT INTO hook_writes VALUES ('answer'); END;
            CREATE TEMP TRIGGER count_counter AFTER UPDATE ON mc_provider_conversations_v2 BEGIN INSERT INTO hook_writes VALUES ('counter'); END;
            CREATE TEMP TRIGGER count_blob_insert AFTER INSERT ON mc_provider_sessions_v1 BEGIN INSERT INTO hook_writes VALUES ('blob'); END;
            CREATE TEMP TRIGGER count_blob_update AFTER UPDATE ON mc_provider_sessions_v1 BEGIN INSERT INTO hook_writes VALUES ('blob'); END;
            CREATE TEMP TRIGGER count_record_update AFTER UPDATE OF record_json ON mc_provider_conversations_v2 BEGIN INSERT INTO hook_writes VALUES ('blob'); END;")?;
        Ok(())
    }).unwrap();
    hook(&store, &l, &message(0), "p1", None, false);
    store.inner.with_conn(|conn| {
        let writes=conn.prepare("SELECT kind FROM hook_writes ORDER BY kind")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(writes,vec!["answer","counter","message"],"unexpected hook durable writes");
        conn.execute_batch("DELETE FROM hook_writes; CREATE TEMP TRIGGER fail_final_write BEFORE UPDATE OF hook_counters_json ON mc_provider_conversations_v2 BEGIN SELECT RAISE(ABORT,'final write failure'); END;")?;
        Ok(())
    }).unwrap();
    // Failure at the final write proves all counted writes share its transaction.
    assert!(store
        .commit_provider_status(&key(), &l, &[message(1)], Some(0), &[])
        .is_err());
    assert_eq!(
        store.load_provider_messages(&key(), "L").unwrap(),
        vec![message(0)]
    );
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[0].state,
        "pending"
    );
    assert!(store.load_tags_for_session("engine").unwrap().is_empty());
    store
        .inner
        .with_conn(|conn| {
            assert_eq!(
                conn.query_row("SELECT count(*) FROM hook_writes", [], |r| r
                    .get::<_, i64>(0))?,
                0
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn views_are_frozen_at_a_version_and_only_application_state_changes() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    store
        .save_provider_view_recipe(&key(), &frozen_recipe(1, "frozen"))
        .unwrap();
    store.set_provider_view_state(&key(), 1, "applied").unwrap();
    let held = recipe_state(&store, 1);
    assert_eq!(held.0, "applied");
    // A second recipe at the same version is refused rather than replacing it.
    assert!(store
        .save_provider_view_recipe(&key(), &frozen_recipe(1, "replaced"))
        .is_err());
    assert_eq!(recipe_state(&store, 1), held);
    assert_eq!(
        store
            .resolve_provider_view(&key(), 1)
            .unwrap()
            .unwrap()
            .recipe
            .synthetic["head"],
        serde_json::json!({"text":"frozen"})
    );
}

#[test]
fn meters_count_sql_rows_before_discarding_a_bounded_read() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    s.inner.with_conn_fenced(|conn| {
        ensure_lineage_tx(conn, &key().conversation_key(), &lineage("L", 1)).unwrap();
        for i in 1..=3 {
            conn.execute("INSERT INTO mc_provider_policy_parts_v1 VALUES (?1,'L',?2,?3,'{\"tag_number\":1}','session')",
                params![key().conversation_key(), i, format!("m{i}#0")])?;
        }
        Ok(())
    }).unwrap();
    let meter = crate::provider_meters::ProviderStoreMeter::start("session", "opencode", "read");
    s.inner
        .with_conn(|conn| {
            let index = ProviderPolicyIndex::new(conn, &key().conversation_key(), "L")?;
            let before = meter.snapshot().sql_result_rows;
            assert!(index.parts_with_tag_range(3, 10, 1).unwrap().is_some());
            assert_eq!(meter.snapshot().sql_result_rows, before);
            // LIMIT 2 steps two rows even though the cap discards the entire result.
            let rejected = index.parts_with_tag_range(1, 2, 1).unwrap();
            assert!(rejected.is_none());
            assert_eq!(meter.snapshot().sql_result_rows - before, 2);
            Ok(())
        })
        .unwrap();
}

#[test]
fn meters_count_appended_utf8_and_zero_on_duplicate_admission() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let l = lineage("L", 1);
    let m = message(1);
    let meter = crate::provider_meters::ProviderStoreMeter::start("session", "opencode", "append");
    hook(&s, &l, &m, "p", None, false);
    let written: u64 = s
        .inner
        .with_conn(|conn| {
            conn.query_row(
                "SELECT length(message_bytes) FROM mc_provider_messages_v1 WHERE ordinal=1",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(meter.snapshot().appended_message_bytes, written);
    let before = meter.snapshot().appended_message_bytes;
    hook(&s, &l, &m, "q", None, false);
    assert_eq!(meter.snapshot().appended_message_bytes, before);
}

#[test]
fn meters_count_answer_and_state_cells_independently_of_message_budget() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let meter = crate::provider_meters::ProviderStoreMeter::start("session", "opencode", "answer");
    hook(&s, &lineage("L", 1), &message(1), "p", None, false);
    let (message, answer, state): (u64, u64, u64) = s.inner.with_conn(|conn| {
        Ok((
            conn.query_row("SELECT sum(length(message_bytes)) FROM mc_provider_messages_v1", [], |r| r.get(0))?,
            conn.query_row("SELECT sum(length(CAST(ops_json AS BLOB))+length(CAST(tags_json AS BLOB))) FROM mc_provider_hook_answers_v1", [], |r| r.get(0))?,
            conn.query_row("SELECT length(CAST(hook_counters_json AS BLOB))+(SELECT length(CAST(policy_json AS BLOB)) FROM mc_provider_hook_answers_v1) FROM mc_provider_conversations_v2", [], |r| r.get(0))?,
        ))
    }).unwrap();
    let actual = meter.snapshot();
    assert_eq!(actual.answer_json_bytes, answer);
    assert_eq!(actual.provider_state_bytes, state);
    assert_eq!(
        actual.module_logical_payload_bytes,
        message + answer + state
    );
}

#[test]
fn meters_discard_rolled_back_payload_and_count_the_retry_once() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let meter = crate::provider_meters::ProviderStoreMeter::start("session", "opencode", "retry");
    s.inner.with_conn(|conn| conn.execute_batch("CREATE TEMP TRIGGER fail_meter_commit BEFORE UPDATE ON mc_provider_conversations_v2 BEGIN SELECT RAISE(ABORT,'meter rollback'); END;")).unwrap();
    let l = lineage("L", 1);
    let m = message(1);
    let result = s.commit_provider_status_page(
        &key(),
        ProviderStatusPage {
            lineage: &l,
            messages: std::slice::from_ref(&m),
            served: None,
            unserved: &[],
            newest: Some(1),
            more: false,
        },
    );
    assert!(result.is_err());
    assert_eq!(meter.snapshot().module_logical_payload_bytes, 0);
    assert_eq!(meter.snapshot().appended_message_bytes, 0);
    assert!(meter.snapshot().sql_result_rows > 0);
    s.inner
        .with_conn(|conn| conn.execute_batch("DROP TRIGGER fail_meter_commit;"))
        .unwrap();
    s.commit_provider_status_page(
        &key(),
        ProviderStatusPage {
            lineage: &l,
            messages: std::slice::from_ref(&m),
            served: None,
            unserved: &[],
            newest: Some(1),
            more: false,
        },
    )
    .unwrap();
    assert_eq!(
        meter.snapshot().appended_message_bytes,
        m.message_bytes.len() as u64
    );
}

#[test]
fn meters_count_inserted_tag_cells_but_not_ignored_tags() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let tag = McTagRow {
        tag_number: 1,
        block_id: "m#0".into(),
        kind: "message".into(),
        token_count: 2,
        created_at_ms: 10,
        source_bytes: std::sync::Arc::from("café 🦀".as_bytes()),
    };
    let meter = crate::provider_meters::ProviderStoreMeter::start("session", "opencode", "tag");
    let mut transaction = crate::provider_meters::WriteMeter::begin();
    s.inner
        .with_conn_fenced(|conn| insert_tags_tx(conn, "engine", std::slice::from_ref(&tag)))
        .unwrap();
    transaction.commit();
    drop(transaction);
    let bytes: u64 = s.inner.with_conn(|conn| conn.query_row("SELECT length(CAST(session_id AS BLOB))+length(CAST(tag_number AS BLOB))+length(CAST(block_id AS BLOB))+length(CAST(kind AS BLOB))+length(CAST(token_count AS BLOB))+length(CAST(created_at_ms AS BLOB))+length(source_bytes) FROM mc_tags", [], |r| r.get(0))).unwrap();
    assert_eq!(meter.snapshot().tag_row_bytes, bytes);
    assert_eq!(meter.snapshot().module_logical_payload_bytes, bytes);
    let mut transaction = crate::provider_meters::WriteMeter::begin();
    s.inner
        .with_conn_fenced(|conn| insert_tags_tx(conn, "engine", std::slice::from_ref(&tag)))
        .unwrap();
    transaction.commit();
    drop(transaction);
    assert_eq!(meter.snapshot().tag_row_bytes, bytes);
}

#[test]
fn historian_pages_bound_rows_across_lineage_cuts() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let messages: Vec<_> = (1..=900).map(message).collect();
    store
        .commit_provider_status(&key(), &lineage("L", 1), &messages, Some(900), &[])
        .unwrap();
    let child = ProviderLineage {
        lineage_id: "C".into(),
        first_ordinal: 501,
        descends_from: Some("L".into()),
        through_ordinal: Some(500),
    };
    store
        .commit_provider_status(
            &key(),
            &child,
            &(501..=1000).map(message).collect::<Vec<_>>(),
            Some(1000),
            &[],
        )
        .unwrap();
    let meter =
        crate::provider_meters::ProviderStoreMeter::start("session", "opencode", "historian-page");
    let mut next = 480;
    let mut ordinals = Vec::new();
    while next <= 520 {
        let page = store
            .load_provider_messages_page(&key(), "C", next, 520, 7)
            .unwrap();
        assert!(!page.is_empty());
        assert!(page.len() <= 7);
        next = page.last().unwrap().ordinal + 1;
        ordinals.extend(page.iter().map(|m| m.ordinal));
    }
    assert_eq!(ordinals, (480..=520).collect::<Vec<_>>());
    assert_eq!(
        meter.snapshot().native_message_rows,
        41,
        "SQL must not materialize covered or future native rows"
    );
    assert_eq!(
        store
            .provider_message_range_bytes(&key(), "C", 480, 520)
            .unwrap(),
        (480..=520)
            .map(|n| message(n).message_bytes.len())
            .sum::<usize>()
    );
}

#[test]
fn historian_reference_index_does_not_materialize_unselected_bodies() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let rows: Vec<_> = (1..=100)
        .map(|n| crate::StoredCompartment {
            sequence: n,
            start_message: n * 10 - 9,
            end_message: n * 10,
            start_message_id: format!("m{}#0", n * 10 - 9),
            end_message_id: format!("m{}#0", n * 10),
            title: format!("Chapter {n}"),
            content: "retained prose ".repeat(1000),
            importance: (n % 100) as i32,
            ..Default::default()
        })
        .collect();
    store.replace_compartments("engine", &rows).unwrap();
    let index = store.load_historian_assembly_index("engine").unwrap();
    assert_eq!(index.snapshot.compartments.len(), 100);
    assert_eq!(index.content_sequences.len(), 100);
    assert!(index
        .snapshot
        .compartments
        .iter()
        .all(|c| c.content.is_empty() && c.title.is_empty() && c.p1.is_none()));
    let selected = store
        .load_historian_reference_compartments("engine", &[1, 50, 100])
        .unwrap();
    assert_eq!(selected.len(), 3);
    assert_eq!(
        selected.iter().map(|c| c.sequence).collect::<Vec<_>>(),
        vec![1, 50, 100]
    );
    assert!(selected
        .iter()
        .all(|c| c.content == "retained prose ".repeat(1000)));
}
