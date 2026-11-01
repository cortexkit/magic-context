use crate::{provider_records::*, *};
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use rusqlite::{params, types::Value};

fn fixture() -> (tempfile::TempDir, McStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: NS.into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into_owned(),
        },
    })
    .unwrap();
    (dir, store)
}

fn key(harness: &str) -> ProviderSessionKey {
    ProviderSessionKey {
        project_root: "/project".into(),
        session: "session".into(),
        harness: harness.into(),
        generation: None,
    }
}

fn seed(store: &McStore, key: &ProviderSessionKey, namespace: &str) {
    let conv = key.conversation_key();
    store.inner.with_conn_fenced(|tx| {
        tx.execute("INSERT INTO mc_provider_conversations_v2(conv_key,project_root,session,harness,engine_namespace) VALUES(?1,?2,?3,?4,?5)", params![conv,key.project_root,key.session,key.harness,namespace])?;
        tx.execute("INSERT INTO mc_provider_sessions_v1 VALUES(?1,?2,?3,'{}')", params![key.project_root,key.session,key.harness])?;
        tx.execute("INSERT OR IGNORE INTO mc_provider_catalogs_v1 VALUES(?1,?2,'{}')", params![key.project_root,key.session])?;
        for sql in [
            "INSERT INTO mc_provider_lineages_v1(conv_key,lineage_id,first_ordinal,session) VALUES(?1,'L',1,?2)",
            "INSERT INTO mc_provider_messages_v1(conv_key,lineage_id,ordinal,mid,message_bytes,session) VALUES(?1,'L',1,'m1',X'7B7D',?2)",
            "INSERT INTO mc_provider_hook_answers_v1(conv_key,answer_seq,lineage_id,subject_mid,hook,ops_json,tags_json,state,session) VALUES(?1,1,'L','m1','pre_user','[]','[]','pending',?2)",
            "INSERT INTO mc_provider_policy_parts_v1 VALUES(?1,'L',1,'m1#0','{}',?2)",
            "INSERT INTO mc_provider_legacy_tags_v1 VALUES(?1,1,'burned',NULL,?2)",
            "INSERT INTO mc_provider_pending_drops_v1 VALUES(?1,1,?2)",
            "INSERT INTO mc_provider_policy_cuts_v1 VALUES(?1,1,'L',1,1,'{}','{}','{}','fixture',?2)",
            "INSERT INTO mc_provider_policy_overrides_v1 VALUES(?1,'L','m1#0',1,1,'{}',?2)",
            "INSERT INTO mc_provider_views_v2(conv_key,version,lineage_id,range_from,range_to,policy_cut_id,view_meta_json,sequence_json,new_head_history_bytes,serializer_profile,render_key,tokenizer_key,state,session) VALUES(?1,1,'L',0,1,1,'{}','[]',X'68656164','pi','render','tokenizer','applied',?2)",
            "INSERT INTO mc_provider_views_v2(conv_key,version,lineage_id,range_from,range_to,base_version,policy_cut_id,view_meta_json,sequence_json,serializer_profile,render_key,tokenizer_key,state,session) VALUES(?1,2,'L',0,1,1,1,'{}','[]','pi','render','tokenizer','produced',?2)",
            "INSERT INTO mc_provider_view_overrides_v1 VALUES(?1,2,'L','m1',1,0,'m1#0','set','{}',?2)",
            "INSERT INTO mc_provider_policy_summaries_v1 VALUES(?1,'{}',?2)",
            "INSERT INTO mc_provider_policy_changes_v1 VALUES(?1,'L','m1#0',NULL,0,?2)",
        ] { tx.execute(sql, params![conv,key.session])?; }
        tx.execute("INSERT OR IGNORE INTO mc_provider_consumed_tags_v1 VALUES(?1,1,?2)", params![namespace,key.session])?;
        tx.execute("INSERT INTO mc_provider_policy_preparations_v1 VALUES(?1,?2,0,'settings','{}',1,X'00',1,?3)", params![conv,namespace,key.session])?;
        Ok(())
    }).unwrap();
}

// Read every provider table independently of the deletion implementation's list.
fn snapshot(
    store: &McStore,
    key: &ProviderSessionKey,
    namespace: &str,
) -> Vec<(String, Vec<Vec<Value>>)> {
    store.inner.with_conn(|conn| {
        let tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mc_provider_%' ORDER BY name")?
            .query_map([], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        tables.into_iter().map(|table| {
            let (predicate, args) = match table.as_str() {
                "mc_provider_sessions_v1" => ("project_root=?1 AND session=?2 AND harness=?3", vec![key.project_root.clone(),key.session.clone(),key.harness.clone()]),
                "mc_provider_catalogs_v1" => ("project_root=?1 AND session=?2", vec![key.project_root.clone(),key.session.clone()]),
                "mc_provider_consumed_tags_v1" | "mc_provider_policy_revisions_v1" => ("engine_namespace=?1", vec![namespace.into()]),
                _ => ("conv_key=?1", vec![key.conversation_key()]),
            };
            let mut stmt = conn.prepare(&format!("SELECT * FROM {table} WHERE {predicate} ORDER BY 1,2"))?;
            let n = stmt.column_count();
            let rows = stmt.query_map(rusqlite::params_from_iter(args), |row| (0..n).map(|i| row.get(i)).collect::<rusqlite::Result<Vec<Value>>>())?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((table, rows))
        }).collect::<rusqlite::Result<_>>()
    }).unwrap()
}

#[test]
fn delete_provider_removes_every_table() {
    let (_dir, store) = fixture();
    let target = key("opencode");
    seed(&store, &target, "engine");
    for (table, rows) in snapshot(&store, &target, "engine") {
        assert!(!rows.is_empty(), "fixture must reach {table}");
    }
    store.delete_provider_conversation(&target).unwrap();
    for (table, rows) in snapshot(&store, &target, "engine") {
        assert!(rows.is_empty(), "left behind {table}: {rows:?}");
    }
}

#[test]
fn delete_provider_second_delete_is_noop() {
    let (_dir, store) = fixture();
    let target = key("opencode");
    seed(&store, &target, "engine");
    store.delete_provider_conversation(&target).unwrap();
    let first = snapshot(&store, &target, "engine");
    store.delete_provider_conversation(&target).unwrap();
    assert_eq!(snapshot(&store, &target, "engine"), first);
}

#[test]
fn delete_provider_preserves_other_conversations_byte_for_byte() {
    let (_dir, store) = fixture();
    let target = key("opencode");
    seed(&store, &target, "shared-engine");
    let mut other_project = target.clone();
    other_project.project_root = "/other-project".into();
    let mut other_session = target.clone();
    other_session.session = "other-session".into();
    let siblings = [
        (key("pi"), "shared-engine"),
        (other_project, "other-project-engine"),
        (other_session, "other-session-engine"),
    ];
    for (key, ns) in &siblings {
        seed(&store, key, ns);
    }
    let before: Vec<_> = siblings
        .iter()
        .map(|(key, ns)| snapshot(&store, key, ns))
        .collect();
    store.delete_provider_conversation(&target).unwrap();
    for ((key, ns), bytes) in siblings.iter().zip(before) {
        assert_eq!(snapshot(&store, key, ns), bytes, "{key:?}");
    }
}

#[test]
fn delete_provider_does_not_delete_memories_notes_or_compartments() {
    let (_dir, store) = fixture();
    let target = key("opencode");
    seed(&store, &target, "engine");
    store.with_context_conn_for_test(|tx| {
        tx.execute("INSERT INTO memories(project_path,category,content,normalized_hash,first_seen_at,last_seen_at,created_at,updated_at) VALUES('/project','learnings','remember','hash',1,1,1,1)", [])?;
        tx.execute("INSERT INTO notes(type,status,content,session_id,project_path,harness,created_at,updated_at) VALUES('smart','pending','note','session','/project','opencode',1,1)", [])?;
        Ok(())
    }).unwrap();
    store
        .replace_compartments(
            "engine",
            &[StoredCompartment {
                content: "history".into(),
                ..Default::default()
            }],
        )
        .unwrap();
    let held = || {
        store
            .with_context_conn_for_test(|conn| {
                ["memories", "notes", "compartments"]
                    .into_iter()
                    .map(|table| {
                        let mut stmt =
                            conn.prepare(&format!("SELECT * FROM {table} ORDER BY 1"))?;
                        let n = stmt.column_count();
                        let rows = stmt
                            .query_map([], |row| {
                                (0..n)
                                    .map(|i| row.get(i))
                                    .collect::<rusqlite::Result<Vec<Value>>>()
                            })?
                            .collect::<rusqlite::Result<Vec<_>>>();
                        rows
                    })
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
    };
    let before = held();
    assert!(before.iter().all(|rows| !rows.is_empty()));
    store.delete_provider_conversation(&target).unwrap();
    assert_eq!(held(), before);
}
