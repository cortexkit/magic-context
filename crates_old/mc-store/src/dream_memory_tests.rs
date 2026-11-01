use super::*;
use crate::dream_domain::{require_tx, DreamDomainLease};
use std::sync::Arc;

fn fixture() -> (McStore, tempfile::TempDir, DreamDomainLease) {
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into_owned(),
        },
    })
    .unwrap();
    store.with_context_conn_for_test(|tx| {
        for (id, project) in [(1, "project"), (2, "project"), (3, "foreign")] {
            let content = format!("Memory {id}");
            tx.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,source_session_id,first_seen_at,created_at,updated_at,last_seen_at) VALUES (?1,?2,'PROJECT',?3,?4,'source',1,1,1,1)", params![id, project, content, crate::compute_normalized_memory_hash(&content)])?;
        }
        tx.execute("INSERT INTO memory_history(memory_id,revision,previous_text,applied_at,reason,evidence_json,source_ids_json,decision_key) VALUES (1,1,'original',1,'edit','[]','[]','old')", [])?;
        tx.execute("INSERT INTO memory_journal(project_path,decision_key,operation,receipt_json,applied_at) VALUES ('project','old','edit','{}',1)", [])?;
        Ok(())
    }).unwrap();
    let lease = store
        .acquire_dream_domain("memory:project", "holder", 10)
        .unwrap()
        .unwrap();
    (store, dir, lease)
}

fn classification(id: i64) -> ClassificationUpdate {
    ClassificationUpdate {
        memory_id: id,
        content_hash_at_prompt: crate::compute_normalized_memory_hash(&format!("Memory {id}")),
        importance: Some(80),
        scope: Some("ecosystem".into()),
        shareable: Some(true),
    }
}

fn mapping(id: i64) -> MappingUpdate {
    MappingUpdate {
        memory_id: id,
        content_hash_at_prompt: crate::compute_normalized_memory_hash(&format!("Memory {id}")),
        mapped_files: Some(vec!["lib.rs".into()]),
        mapping_origin: "mapper".into(),
    }
}

#[test]
fn metadata_writes_reject_foreign_inactive_and_stale_memories() {
    let (store, _dir, lease) = fixture();
    store
        .with_context_conn_for_test(|tx| {
            tx.execute("UPDATE memories SET status='archived' WHERE id=2", [])?;
            Ok(())
        })
        .unwrap();
    let mut stale = classification(1);
    stale.content_hash_at_prompt = "stale".into();
    let result = store
        .commit_dream_classifications(
            "project",
            &[stale, classification(2), classification(3)],
            20,
            |tx| require_tx(tx, &lease, 20),
            |_, _| panic!("rejected metadata must not enqueue"),
        )
        .unwrap();
    assert!(result.accepted.is_empty());
    let mut stale = mapping(1);
    stale.content_hash_at_prompt = "stale".into();
    let result = store
        .commit_dream_mappings(
            "project",
            &[stale, mapping(2), mapping(3)],
            20,
            |tx| require_tx(tx, &lease, 20),
            |_, _| panic!("rejected mapping must not enqueue"),
        )
        .unwrap();
    assert!(result.is_empty());
}

#[test]
fn identical_commits_preserve_embedding_retry_state_and_timestamps() {
    let (store, _dir, lease) = fixture();
    let queue_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let queue = |_: &Transaction<'_>, _: &StoredMemoryFull| {
        queue_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    };
    for now in [20, 30] {
        let result = store
            .commit_dream_classifications(
                "project",
                &[classification(1)],
                now,
                |tx| require_tx(tx, &lease, now),
                queue,
            )
            .unwrap();
        assert_eq!(result.accepted, [1]);
        assert_eq!(result.changed, usize::from(now == 20));
        assert_eq!(
            store
                .commit_dream_mappings(
                    "project",
                    &[mapping(1)],
                    now,
                    |tx| require_tx(tx, &lease, now),
                    queue
                )
                .unwrap(),
            [1]
        );
    }
    assert_eq!(queue_calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    store
        .with_context_read(|db| {
            assert_eq!(
                db.query_row("SELECT classified_at FROM memories WHERE id=1", [], |row| {
                    row.get::<_, i64>(0)
                })?,
                20
            );
            assert_eq!(
                db.query_row(
                    "SELECT mapped_at FROM memory_verifications WHERE memory_id=1",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                20
            );
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM memory_history", [], |row| row
                    .get::<_, i64>(0))?,
                1
            );
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM memory_journal", [], |row| row
                    .get::<_, i64>(0))?,
                1
            );
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM memory_mutation_log", [], |row| row
                    .get::<_, i64>(0))?,
                0
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn classification_queue_failure_preserves_prior_history_and_undo() {
    let (store, _dir, lease) = fixture();
    let result = store.commit_dream_classifications(
        "project",
        &[classification(1), classification(2)],
        20,
        |tx| require_tx(tx, &lease, 20),
        |_, memory| {
            if memory.id == 2 {
                Err(rusqlite::Error::InvalidQuery)
            } else {
                Ok(())
            }
        },
    );
    assert!(result.is_err());
    store
        .with_context_read(|db| {
            assert_eq!(
                db.query_row(
                    "SELECT COUNT(*) FROM memories WHERE classified_at IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                0
            );
            assert_eq!(
                db.query_row("SELECT previous_text FROM memory_history", [], |row| row
                    .get::<_, String>(
                    0
                ))?,
                "original"
            );
            assert_eq!(
                db.query_row("SELECT receipt_json FROM memory_journal", [], |row| row
                    .get::<_, String>(
                    0
                ))?,
                "{}"
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn pending_historian_items_yield_after_three_recorded_sends() {
    let (store, _dir, _lease) = fixture();
    store.with_context_conn_for_test(|tx| {
        for id in [1, 2] {
            tx.execute("INSERT INTO memory_classification_items(enqueue_sequence,project_path,memory_id,saved_revision,source_session_id,tool_call_part_id,save_ordinal) VALUES (?1,'project',?1,1,'source',?2,1)", params![id, format!("part-{id}")])?;
        }
        for send in 0..3 {
            tx.execute("INSERT INTO memory_stage_attempts(stage_key,project_path,publication_id,run_attempt,stage,session_id,carrier,state,request_json,started_at) VALUES (?1,'project',?1,1,'turn_two','source','fake','completed','{\"items\":[1]}',1)", [format!("send-{send}")])?;
        }
        Ok(())
    }).unwrap();
    let rows = store.load_dream_metadata("project").unwrap();
    assert_eq!(rows.len(), 2);
    assert!(!rows[0].open_classification);
    assert!(rows[1].open_classification);
}

#[test]
fn classification_and_mapping_refuse_memory_authority_elsewhere() {
    let (store, _dir, lease) = fixture();
    store
        .with_context_conn_for_test(|tx| {
            tx.execute(
                "UPDATE single_store_state SET state='required' WHERE id=1",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    assert!(store
        .commit_dream_classifications(
            "project",
            &[classification(1)],
            20,
            |tx| require_tx(tx, &lease, 20),
            |_, _| panic!("refused metadata must not enqueue")
        )
        .is_err());
    assert!(store
        .commit_dream_mappings(
            "project",
            &[mapping(1)],
            20,
            |tx| require_tx(tx, &lease, 20),
            |_, _| panic!("refused mapping must not enqueue")
        )
        .is_err());
    store
        .with_context_read(|db| {
            assert_eq!(
                db.query_row(
                    "SELECT COUNT(*) FROM memories WHERE classified_at IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                0
            );
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM memory_verifications", [], |row| row
                    .get::<_, i64>(
                    0
                ))?,
                0
            );
            Ok(())
        })
        .unwrap();
}
