use super::*;
use crate::{
    memory_lifecycle::applier::{AdmissionOperation, AdmissionRequest},
    McStore,
};
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use rusqlite::Connection;
use serde_json::json;
use std::sync::{Arc, Mutex};

fn pin() -> serde_json::Value {
    json!({"profile":{"name":"@cortexkit/memory-swe","version":"1.0.0","digest":"profile-digest","state":"resolved","parity":true},"project_id":"project-id","snapshot_digest":"snapshot-from-bind","category_ids":{"NAMING":"swe:naming","KNOWN_ISSUES":"swe:constraints"}})
}

fn fixture() -> (tempfile::TempDir, McStore, Arc<Mutex<Vec<CreateEvent>>>) {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: crate::NS.into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into(),
        },
    })
    .unwrap();
    set_pin(&store, pin());
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    store.set_memory_create_hook(Some(Arc::new(move |_, event| {
        captured.lock().unwrap().push(event.clone());
        Ok(())
    })));
    (dir, store, events)
}

fn set_pin(store: &McStore, pin: serde_json::Value) {
    let mut meta = store.load_meta("session").unwrap();
    meta.meta.memory_context = Some(pin);
    store
        .commit_meta("session", meta.row_version, &meta.meta)
        .unwrap();
}

fn admit(
    store: &McStore,
    key: &str,
    content: &str,
    now: i64,
) -> crate::memory_lifecycle::applier::ApplierReceipt {
    let mut request = AdmissionRequest::new(
        key,
        AdmissionOperation::AgentSave,
        "project-path",
        "NAMING",
        content,
        now,
    );
    request.source_session_id = Some("session");
    store.admit_memory(&request).unwrap()
}

fn assert_event(
    store: &McStore,
    event: &CreateEvent,
    actor: Actor,
    kind: CreateKind,
    ordinals: &[i64],
) {
    assert_eq!(event.actor, actor);
    assert_eq!(event.kind, kind);
    assert_eq!(event.session_id.as_deref(), Some("session"));
    assert_eq!(event.ordinals, ordinals);
    assert_eq!(event.writer_project_id.as_deref(), Some("project-id"));
    assert_eq!(
        event.owner,
        Some(Owner {
            kind: "project".into(),
            id: "project-id".into()
        })
    );
    assert_eq!(event.effective_category_id.as_deref(), Some("swe:naming"));
    assert_eq!(event.snapshot_digest.as_deref(), Some("snapshot-from-bind"));
    assert_eq!(
        event.origin_profile.as_ref().unwrap().name,
        "@cortexkit/memory-swe"
    );
    store
        .context_read(|conn| {
            let placement = read_placement(conn, event.memory_id)?.unwrap();
            assert_eq!(placement.level, "project");
            assert_eq!(Some(placement.owner), event.owner);
            assert_eq!(placement.origin_profile, event.origin_profile);
            assert_eq!(placement.origin_category, event.effective_category_id);
            Ok(())
        })
        .unwrap();
}

fn facade(
    store: &McStore,
    action: &str,
    apply: impl FnOnce(&crate::FacadeMutationTxn<'_>) -> Result<Vec<u8>, String>,
) {
    store
        .with_facade_command(
            "/route",
            "project-path",
            "memories",
            "session",
            "ctx_memory",
            action,
            None,
            apply,
        )
        .unwrap();
}

#[test]
fn admission_placement_and_hook() {
    let (_dir, store, events) = fixture();
    let mut request = AdmissionRequest::new(
        "save",
        AdmissionOperation::AgentSave,
        "project-path",
        "NAMING",
        "Use snake case",
        10,
    );
    request.source_session_id = Some("session");
    request.classification_anchor = Some(crate::memory_lifecycle::applier::ClassificationAnchor {
        tool_call_part_id: "part",
        save_ordinal: 7,
    });
    store.admit_memory(&request).unwrap();
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_event(
        &store,
        &events[0],
        Actor::MainAgent,
        CreateKind::Create,
        &[7],
    );
}

#[test]
fn facade_save_placement_and_hook() {
    let (_dir, store, events) = fixture();
    facade(&store, "write", |tx| {
        let mut request = AdmissionRequest::new(
            "facade-save",
            AdmissionOperation::AgentSave,
            "project-path",
            "NAMING",
            "Use snake case",
            10,
        );
        request.source_session_id = Some("session");
        tx.admit_memory(&request)?;
        Ok(vec![])
    });
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_event(
        &store,
        &events[0],
        Actor::MainAgent,
        CreateKind::Create,
        &[],
    );
}

#[test]
fn canonical_merge_hook_is_not_create_and_uses_writer_origin() {
    let (_dir, store, events) = fixture();
    let a = admit(&store, "a", "source a", 10).memory_id.unwrap();
    let b = admit(&store, "b", "source b", 10).memory_id.unwrap();
    store
        .context_write(&["memory_placement"], |tx| {
            tx.execute(
                "UPDATE memory_placement SET origin_profile_digest='old-digest'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    events.lock().unwrap().clear();
    facade(&store, "merge", |tx| {
        tx.merge_memories_canonical(
            "project-path",
            &[a, b],
            "merged source",
            Some("session"),
            20,
        )
        .map_err(|e| e.to_string())?;
        Ok(vec![])
    });
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_event(
        &store,
        &events[0],
        Actor::MainAgent,
        CreateKind::MergeSurvivor,
        &[],
    );
    assert_eq!(
        events[0].origin_profile.as_ref().unwrap().digest,
        "profile-digest"
    );
}

#[test]
fn historian_wrapper_placement_and_hook() {
    let (_dir, store, events) = fixture();
    store
        .promote_facts(
            "project-path",
            &[crate::FactCandidate {
                category: "NAMING".into(),
                content: "historian fact".into(),
                source_session_id: Some("session".into()),
                ..Default::default()
            }],
        )
        .unwrap();
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_event(
        &store,
        &events[0],
        Actor::Historian,
        CreateKind::Create,
        &[],
    );
}

#[test]
fn historian_fold_placement_and_hook() {
    let (_dir, store, events) = fixture();
    let write =
        crate::context_writes::PendingContextWrite::Fold(crate::context_writes::FoldWrite {
            project_path: "project-path".into(),
            promote_facts: true,
            compartments: vec![crate::StoredCompartment {
                sequence: 1,
                start_message: 3,
                end_message: 5,
                ..Default::default()
            }],
            facts: vec![crate::FactCandidate {
                category: "NAMING".into(),
                content: "fold fact".into(),
                source_session_id: Some("session".into()),
                ..Default::default()
            }],
            fence: None,
            lifecycle_publication_id: None,
            harness: Some("opencode".into()),
            published_at_ms: 10,
            events: vec![],
            primer_candidates: vec![],
            user_memory_candidates: vec![],
        });
    store
        .complete_pending_context_write("session", &write)
        .unwrap();
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_event(
        &store,
        &events[0],
        Actor::Historian,
        CreateKind::Create,
        &[3, 4, 5],
    );
}

fn counts(conn: &Connection) -> Vec<i64> {
    [
        "memories",
        "memory_placement",
        "memory_ops",
        "memory_outbox",
        "memory_sync_state",
    ]
    .iter()
    .map(|t| {
        conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
            .unwrap()
    })
    .collect()
}

#[test]
fn dedup_keeps_seen_receipts_without_placement_or_sync_effects() {
    let (_dir, store, events) = fixture();
    let captured = events.clone();
    store.set_memory_create_hook(Some(Arc::new(move |tx, event| {
        captured.lock().unwrap().push(event.clone());
        ledger::advance(tx, "account", "device", 2, 99, 1)?;
        ledger::append_op(tx, "account", "device", 1, event, "digest", b"{}", 10)?;
        ledger::enqueue(tx, "account", "device", 1)
    })));
    let id = admit(&store, "one", "same content", 10).memory_id.unwrap();
    let before = store.context_read(|conn| Ok(counts(conn))).unwrap();
    let second = admit(&store, "two", "  SAME content ", 20);
    assert_eq!(second.memory_id, Some(id));
    assert_eq!(second.inserted, Some(false));
    assert_eq!(events.lock().unwrap().len(), 1);
    store
        .context_read(|conn| {
            assert_eq!(counts(conn), before);
            assert_eq!(
                conn.query_row(
                    "SELECT next_local_id,hlc_wall_ms,hlc_logical FROM memory_sync_state",
                    [],
                    |r| Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?
                    ))
                )?,
                (2, 99, 1)
            );
            assert_eq!(
                conn.query_row(
                    "SELECT seen_count,last_seen_at,updated_at FROM memories WHERE id=?1",
                    [id],
                    |r| Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?
                    ))
                )?,
                (2, 20, 20)
            );
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM memory_decision_receipts", [], |r| r
                    .get::<_, i64>(
                    0
                ))?,
                2
            );
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM memory_journal", [], |r| r
                    .get::<_, i64>(0))?,
                2
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn missing_placement_is_legacy_not_workspace() {
    let (_dir, store, _events) = fixture();
    let mut legacy = pin();
    legacy.as_object_mut().unwrap().remove("category_ids");
    set_pin(&store, legacy);
    let id = admit(&store, "legacy", "legacy text", 10)
        .memory_id
        .unwrap();
    store
        .context_read(|conn| {
            assert_eq!(read_placement(conn, id)?, None);
            let row = crate::load_memory_full_tx(conn, id)?.unwrap();
            assert_eq!(row.project_path, "project-path");
            assert_eq!(row.content, "legacy text");
            Ok(())
        })
        .unwrap();
    assert_eq!(
        admit(&store, "legacy-dedup", "LEGACY text", 20).memory_id,
        Some(id)
    );
    assert_eq!(
        store
            .load_memory_render_snapshot("project-path", None, 0)
            .unwrap()
            .memories
            .len(),
        1
    );
    assert_eq!(
        store
            .search_visible_memory_contents("project-path", "legacy")
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn orphan_placement_is_inert() {
    let (_dir, store, _events) = fixture();
    let id = admit(&store, "orphan", "orphan text", 10)
        .memory_id
        .unwrap();
    store
        .context_write(&["memories"], |tx| {
            tx.execute("DELETE FROM memories WHERE id=?1", [id])?;
            assert_eq!(read_placement(tx, id)?, None);
            assert_eq!(counts(tx), vec![0, 1, 0, 0, 0]);
            Ok(())
        })
        .unwrap();
    assert!(store
        .load_memory_render_snapshot("project-path", None, 0)
        .unwrap()
        .memories
        .is_empty());
    assert!(store.get_memory_full(id).unwrap().is_none());
    assert!(store
        .search_visible_memory_contents("project-path", "orphan")
        .unwrap()
        .is_empty());
}

#[test]
fn frozen_category_snapshot_not_bundled_lookup() {
    let (_dir, store, events) = fixture();
    let mut custom = pin();
    custom["category_ids"]["NAMING"] = json!("acme:terms");
    set_pin(&store, custom);
    let id = admit(&store, "custom", "custom mapping", 10)
        .memory_id
        .unwrap();
    assert_eq!(
        events.lock().unwrap()[0].effective_category_id.as_deref(),
        Some("acme:terms")
    );
    store
        .context_read(|conn| {
            assert_eq!(
                read_placement(conn, id)?
                    .unwrap()
                    .origin_category
                    .as_deref(),
                Some("acme:terms")
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn missing_category_snapshot_never_guesses_placement() {
    let (_dir, store, events) = fixture();
    let mut legacy = pin();
    legacy.as_object_mut().unwrap().remove("category_ids");
    set_pin(&store, legacy);
    admit(&store, "old-pin", "known naming category", 10);
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert!(events[0].owner.is_none());
    assert!(events[0].origin_profile.is_none());
    assert!(events[0].snapshot_digest.is_none());
    store
        .context_read(|conn| {
            assert_eq!(counts(conn), vec![1, 0, 0, 0, 0]);
            Ok(())
        })
        .unwrap();
}

#[test]
fn no_project_and_degraded_origins() {
    let (_dir, store, events) = fixture();
    for (index, state) in ["unresolved", "conflict", "blocked", "unavailable"]
        .iter()
        .enumerate()
    {
        let mut degraded = pin();
        degraded["profile"]["state"] = json!(state);
        set_pin(&store, degraded);
        let id = admit(
            &store,
            &format!("degraded-{index}"),
            &format!("text {index}"),
            10,
        )
        .memory_id
        .unwrap();
        store
            .context_read(|conn| {
                let p = read_placement(conn, id)?.unwrap();
                assert!(p.origin_profile.is_none());
                assert!(p.origin_category.is_none());
                Ok(())
            })
            .unwrap();
    }
    for (index, state) in ["resolved", "entorhinal_not_answering"].iter().enumerate() {
        let mut no_project = pin();
        no_project["project_id"] = json!(null);
        no_project["profile"]["state"] = json!(state);
        set_pin(&store, no_project);
        let id = admit(
            &store,
            &format!("no-project-{index}"),
            &format!("no project {index}"),
            10,
        )
        .memory_id
        .unwrap();
        store
            .context_read(|conn| {
                assert_eq!(read_placement(conn, id)?, None);
                Ok(())
            })
            .unwrap();
    }
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 6);
    for event in &events[4..] {
        assert!(event.owner.is_none());
        assert!(event.origin_profile.is_none());
        assert!(event.snapshot_digest.is_none());
    }
}

#[test]
fn merge_legacy_and_placed_same_owner_and_refuse_different_owners() {
    let (_dir, store, _events) = fixture();
    let a = admit(&store, "a", "source a", 10).memory_id.unwrap();
    let b = admit(&store, "b", "source b", 10).memory_id.unwrap();
    store
        .context_write(&["memory_placement"], |tx| {
            tx.execute("DELETE FROM memory_placement WHERE memory_id=?1", [a])?;
            Ok(())
        })
        .unwrap();
    facade(&store, "merge", |tx| {
        tx.merge_memories_canonical(
            "project-path",
            &[a, b],
            "legacy plus placed",
            Some("session"),
            20,
        )
        .map_err(|e| e.to_string())?;
        Ok(vec![])
    });
    let c = admit(&store, "c", "source c", 30).memory_id.unwrap();
    let d = admit(&store, "d", "source d", 30).memory_id.unwrap();
    store
        .context_write(&["memory_placement"], |tx| {
            tx.execute(
                "UPDATE memory_placement SET owner_id='other' WHERE memory_id=?1",
                [d],
            )?;
            Ok(())
        })
        .unwrap();
    let result = store.with_facade_command(
        "/route",
        "project-path",
        "memories",
        "session",
        "ctx_memory",
        "merge",
        None,
        |tx| {
            tx.merge_memories_canonical(
                "project-path",
                &[c, d],
                "different owners",
                Some("session"),
                40,
            )
            .map_err(|e| e.to_string())?;
            Ok(vec![])
        },
    );
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("merge_owner_mismatch"));
}

#[test]
fn atomic_create_rolls_back_memory_placement_ledger_outbox_and_clock() {
    for stage in ["after_memory", "after_placement", "after_ledger"] {
        let (_dir, store, _events) = fixture();
        if stage == "after_memory" {
            store.context_write(&["memory_placement"],|tx| {tx.execute_batch("CREATE TRIGGER fail_placement BEFORE INSERT ON memory_placement BEGIN SELECT RAISE(ABORT,'after memory'); END;")}).unwrap();
        } else {
            store.set_memory_create_hook(Some(Arc::new(move |tx, event| {
                ledger::advance(tx, "account", "device", 2, 99, 1)?;
                if stage == "after_placement" {
                    return Err(refuse("after placement"));
                }
                ledger::append_op(tx, "account", "device", 1, event, "digest", b"{}", 10)?;
                Err(refuse("between ledger and outbox"))
            })));
        }
        let mut request = AdmissionRequest::new(
            stage,
            AdmissionOperation::AgentSave,
            "project-path",
            "NAMING",
            "atomic text",
            10,
        );
        request.source_session_id = Some("session");
        assert!(store.admit_memory(&request).is_err(), "{stage}");
        store
            .context_read(|conn| {
                assert_eq!(counts(conn), vec![0, 0, 0, 0, 0], "{stage}");
                Ok(())
            })
            .unwrap();
    }
}

#[test]
fn unavailable_levels_refuse_without_rows() {
    let (_dir, store, _events) = fixture();
    for level in ["workspace", "global", "agent"] {
        let mut request = AdmissionRequest::new(
            level,
            AdmissionOperation::AgentSave,
            "project-path",
            "NAMING",
            "unavailable",
            10,
        );
        request.requested_level = Some(level);
        request.source_session_id = Some("session");
        assert!(store
            .admit_memory(&request)
            .unwrap_err()
            .to_string()
            .contains("level_unavailable"));
        store
            .context_read(|conn| {
                assert_eq!(counts(conn), vec![0, 0, 0, 0, 0]);
                Ok(())
            })
            .unwrap();
    }
    requested_level("project").unwrap();
}

#[test]
fn canonical_merge_hook_observes_final_category() {
    let (_dir, store, events) = fixture();
    let a = admit(&store, "a", "source a", 10).memory_id.unwrap();
    let b = admit(&store, "b", "source b", 10).memory_id.unwrap();
    let mut changed = pin();
    changed["category_ids"]["ARCHITECTURE"] = json!("swe:architecture");
    set_pin(&store, changed);
    events.lock().unwrap().clear();
    facade(&store, "merge", |tx| {
        tx.merge_memories_canonical_with_category(
            "project-path",
            &[a, b],
            "merged category",
            Some("session"),
            20,
            Some("ARCHITECTURE"),
        )
        .map_err(|e| e.to_string())?;
        Ok(vec![])
    });
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, CreateKind::MergeSurvivor);
    assert_eq!(events[0].category_tag, "ARCHITECTURE");
    assert_eq!(
        events[0].effective_category_id.as_deref(),
        Some("swe:architecture")
    );
}
