//! Independent checks against per-block release accounting.
use super::*;
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

fn fixture(dir: &std::path::Path) -> (McStore, ProviderSessionKey, ProviderLineage) {
    let store = McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: crate::NS.into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into(),
        },
    })
    .unwrap();
    let key = ProviderSessionKey {
        project_root: "/review".into(),
        session: "s".into(),
        harness: "opencode".into(),
    };
    store
        .save_provider_conversation(
            &key,
            &ProviderConversation {
                engine_namespace: "s".into(),
                ..Default::default()
            },
        )
        .unwrap();
    let lineage = ProviderLineage {
        lineage_id: "L".into(),
        first_ordinal: 1,
        descends_from: None,
        through_ordinal: None,
    };
    (store, key, lineage)
}

#[test]
fn review_queueing_one_text_block_keeps_its_sibling_reclaimable() {
    let dir = tempfile::tempdir().unwrap();
    let (store, key, lineage) = fixture(dir.path());
    let message = ProviderMessage {
        mid: "u".into(),
        ordinal: 1,
        message_bytes: br#"{"text":["first","second"]}"#.to_vec(),
    };
    let subject = ProviderSubject {
        subject_mid: "u".into(),
        hook: "pre_user".into(),
        subject_part: String::new(),
    };
    store
        .commit_provider_hook(
            &key,
            ProviderHookRequest {
                lineage: &lineage,
                message: Some(&message),
                served_through_ordinal: None,
                unserved_subjects: &[],
                repeat_subject: Some(&subject),
            },
            |ctx| {
                let mut counters = ctx.counters.clone();
                counters["answer_policy"] = json!({"metrics":ProviderPolicyTotals {
                    text_tokens: 30, reclaimable_tokens: 30, real_users: 1, ..Default::default()
                }});
                let tags = [(1, 10), (2, 20)]
                    .into_iter()
                    .map(|(number, tokens)| ProviderAnswerTag {
                        number,
                        block_id: format!("u#{}", number - 1),
                        kind: "message".into(),
                        source: "text".into(),
                        token_count: tokens,
                        created_at_ms: 1,
                    })
                    .collect();
                Ok((
                    ProviderHookWrite {
                        answer: Some(ProviderHookAnswer {
                            subject: subject.clone(),
                            ordinal: 1,
                            ops_json: "[]".into(),
                            tags,
                        }),
                        counters,
                    },
                    (),
                ))
            },
        )
        .unwrap();
    store
        .commit_provider_status(&key, &lineage, &[], Some(1), &[])
        .unwrap();
    store.queue_provider_drops(&key, &[1]).unwrap();
    assert_eq!(store.load_provider_pending_drops(&key).unwrap(), [1]);
    let totals = store.load_provider_policy_totals(&key).unwrap();
    assert_eq!(
        totals.text_tokens, 30,
        "queueing does not change served token mass"
    );
    assert_eq!(totals.reclaimable_tokens, 20,
        "from-scratch block accounting excludes only the queued 10-token block, not its 20-token sibling");
}

#[test]
fn review_pending_burns_and_unknown_subjects_are_idempotent_across_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (store, key, lineage) = fixture(dir.path());
    let message = ProviderMessage {
        mid: "a".into(),
        ordinal: 1,
        message_bytes: b"{}".to_vec(),
    };
    let subject = ProviderSubject {
        subject_mid: "a".into(),
        hook: "post_tool".into(),
        subject_part: "p".into(),
    };
    store
        .commit_provider_hook(
            &key,
            ProviderHookRequest {
                lineage: &lineage,
                message: Some(&message),
                served_through_ordinal: None,
                unserved_subjects: &[],
                repeat_subject: Some(&subject),
            },
            |ctx| {
                let mut counters = ctx.counters.clone();
                counters["answer_policy"] = json!({"metrics": ProviderPolicyTotals {
                    tool_tokens: 20, reclaimable_tokens: 20, tool_outputs: 1, ..Default::default()
                }});
                Ok((
                    ProviderHookWrite {
                        answer: Some(ProviderHookAnswer {
                            subject: subject.clone(),
                            ordinal: 1,
                            ops_json: "[]".into(),
                            tags: vec![ProviderAnswerTag {
                                number: 1,
                                block_id: "a#1".into(),
                                kind: "tool_result".into(),
                                source: "output".into(),
                                token_count: 20,
                                created_at_ms: 1,
                            }],
                        }),
                        counters,
                    },
                    (),
                ))
            },
        )
        .unwrap();
    store.queue_provider_drops(&key, &[1]).unwrap();
    let unknown = ProviderSubject {
        subject_mid: "never".into(),
        ..subject.clone()
    };
    let burns = [subject.clone(), subject, unknown];
    store
        .commit_provider_status(&key, &lineage, &[], Some(1), &burns)
        .unwrap();
    drop(store);
    let descriptor = StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: crate::NS.into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into(),
        },
    };
    let store = McStore::open_for_test(&descriptor).unwrap();
    store
        .commit_provider_status(&key, &lineage, &[], Some(1), &burns)
        .unwrap();
    assert!(store.load_tags_for_session("s").unwrap().is_empty());
    assert!(store.load_provider_pending_drops(&key).unwrap().is_empty());
    assert_eq!(
        store.load_provider_policy_totals(&key).unwrap(),
        ProviderPolicyTotals::default()
    );
    assert_eq!(
        store.load_provider_hook_answers(&key).unwrap()[0].state,
        "burned"
    );
}

fn reopen_descriptor(dir: &std::path::Path) -> StorageDescriptor {
    StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: crate::NS.into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into(),
        },
    }
}

#[test]
#[ignore = "subprocess transaction crash-point helper"]
fn r2_drop_commit_crash_child() {
    let dir = std::env::var("MC_R2_DROP_CRASH_DIR").expect("child fixture directory");
    let store = McStore::open_for_test(&reopen_descriptor(std::path::Path::new(&dir))).unwrap();
    let namespace = "engine:r2";
    let version = store.load_meta(namespace).unwrap().row_version;
    let id = store.load_pending_agent_drops(namespace).unwrap()[0].id;
    store.inner.with_conn(|conn|conn.execute_batch("CREATE TRIGGER r2_before_drop_commit BEFORE DELETE ON pending_agent_drops BEGIN SELECT RAISE(ABORT,'crash cut before engine drop commit'); END;")).unwrap();
    assert!(store
        .commit_with_consumed_drops(
            namespace,
            version,
            &crate::CoreState::default(),
            &crate::ModuleMeta::default(),
            &[id],
            None
        )
        .is_err());
    std::process::exit(91);
}

#[test]
fn r2_crash_before_commit_preserves_namespace_fence_and_applies_drop_once() {
    let dir = tempfile::tempdir().unwrap();
    let (store, key, lineage) = fixture(dir.path());
    let mut conversation = store.load_provider_conversation(&key).unwrap().unwrap();
    conversation.engine_namespace = "engine:r2".into();
    store
        .save_provider_conversation(&key, &conversation)
        .unwrap();
    let version = store
        .commit(
            "engine:r2",
            None,
            &crate::CoreState::default(),
            &crate::ModuleMeta::default(),
        )
        .unwrap();
    let message = ProviderMessage {
        mid: "target".into(),
        ordinal: 1,
        message_bytes: b"{}".to_vec(),
    };
    store.commit_provider_hook(&key,ProviderHookRequest {lineage:&lineage,message:Some(&message),served_through_ordinal:None,unserved_subjects:&[],repeat_subject:None},|ctx| {
        let mut counters=ctx.counters.clone();counters["answer_policy"]=json!({"metrics":ProviderPolicyTotals {tool_tokens:80,reclaimable_tokens:80,tool_outputs:1,..Default::default()}});
        Ok((ProviderHookWrite {answer:Some(ProviderHookAnswer {subject:ProviderSubject {subject_mid:"target".into(),hook:"post_tool".into(),subject_part:"part".into()},ordinal:1,ops_json:"[]".into(),tags:vec![ProviderAnswerTag {number:1,block_id:"target#1".into(),kind:"tool_result".into(),source:"payload".into(),token_count:80,created_at_ms:1}]}),counters},()))
    }).unwrap();
    store
        .commit_provider_status(&key, &lineage, &[], Some(1), &[])
        .unwrap();
    store.queue_provider_drops(&key, &[1]).unwrap();
    store
        .append_pending_agent_drops("engine:r2", &["target#1".into()], 1)
        .unwrap();
    drop(store);
    let exit = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "provider_log::review_tests::r2_drop_commit_crash_child",
            "--nocapture",
        ])
        .env("MC_R2_DROP_CRASH_DIR", dir.path())
        .output()
        .unwrap();
    assert_eq!(
        exit.status.code(),
        Some(91),
        "child did not reach crash cut: {}",
        String::from_utf8_lossy(&exit.stderr)
    );
    let store = McStore::open_for_test(&reopen_descriptor(dir.path())).unwrap();
    assert_eq!(
        store.load_meta("engine:r2").unwrap().row_version,
        Some(version)
    );
    assert_eq!(store.load_provider_pending_drops(&key).unwrap(), [1]);
    assert_eq!(
        store.load_pending_agent_drops("engine:r2").unwrap().len(),
        1
    );
    assert!(store.provider_answer_tag_known(&key, 1).unwrap());
    assert!(
        !store
            .inner
            .with_conn(|conn| tag_consumed_tx(conn, "engine:r2", 1))
            .unwrap(),
        "consumed fence must roll back with the engine commit"
    );
    store
        .inner
        .with_conn(|conn| conn.execute_batch("DROP TRIGGER r2_before_drop_commit"))
        .unwrap();
    let id = store.load_pending_agent_drops("engine:r2").unwrap()[0].id;
    let next = store
        .commit_with_consumed_drops(
            "engine:r2",
            Some(version),
            &crate::CoreState::default(),
            &crate::ModuleMeta::default(),
            &[id],
            None,
        )
        .unwrap();
    assert!(store.load_provider_pending_drops(&key).unwrap().is_empty());
    assert!(store
        .load_pending_agent_drops("engine:r2")
        .unwrap()
        .is_empty());
    assert!(!store.provider_answer_tag_known(&key, 1).unwrap());
    assert!(store.queue_provider_drops(&key, &[1]).is_err());
    assert_eq!(
        store.load_provider_policy_totals(&key).unwrap().tool_tokens,
        0
    );
    store.consume_provider_drops(&key, &[1, 1]).unwrap();
    store
        .commit_with_consumed_drops(
            "engine:r2",
            Some(next),
            &crate::CoreState::default(),
            &crate::ModuleMeta::default(),
            &[id, id],
            None,
        )
        .unwrap();
    assert_eq!(
        store.load_provider_policy_totals(&key).unwrap().tool_tokens,
        0
    );
    assert!(
        !store
            .inner
            .with_conn(|conn| tag_consumed_tx(conn, "another-namespace", 1))
            .unwrap(),
        "number fences must not cross engine namespaces"
    );
}
