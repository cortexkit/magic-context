use super::*;
use crate::dream_domain::{require_tx, DreamDomainLease};

fn fixture() -> (McStore, tempfile::TempDir, DreamDomainLease) {
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    let root = std::env::temp_dir().join("magic-context/i5-5b");
    std::fs::create_dir_all(&root).unwrap();
    let dir = tempfile::tempdir_in(root).unwrap();
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
            tx.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,source_session_id,first_seen_at,created_at,updated_at,last_seen_at) VALUES(?1,?2,'PROJECT',?3,?4,'source',1,1,1,1)", params![id, project, content, crate::compute_normalized_memory_hash(&content)])?;
            tx.execute("INSERT INTO memory_verifications(memory_id,file_path,verified_at,mapped_at,mapping_origin) VALUES(?1,'lib.rs',20,10,'mapper')", [id])?;
        }
        Ok(())
    }).unwrap();
    let lease = store
        .acquire_dream_domain("memory:project", "holder", 100)
        .unwrap()
        .unwrap();
    (store, dir, lease)
}

fn identity() -> VerifyIdentity<'static> {
    VerifyIdentity {
        project: "project",
        session: "session",
        harness: "opencode",
        invocation: "invocation",
    }
}

#[test]
fn dream_verify_snapshot_reads_timestamps_and_durable_receipts() {
    let (store, _dir, _) = fixture();
    let identity = identity();
    store.with_context_conn_for_test(|tx| {
        tx.execute("UPDATE memories SET metadata_json=?1 WHERE id=1", [serde_json::json!({"dreamerVerifiedAt":20,"dreamerVerifiedCommit":"a".repeat(40)}).to_string()])?;
        tx.execute("INSERT INTO memory_decision_receipts(decision_key,project_path,receipt_json,resolved_at) VALUES(?1,'project','{}',20)", [identity.receipt_key(1)])?;
        Ok(())
    }).unwrap();
    let rows = store.load_dream_verify(&identity).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].verified_at, 20);
    assert_eq!(rows[0].files, ["lib.rs"]);
    assert_eq!(rows[0].verified_commit, Some("a".repeat(40)));
    assert!(rows[0].decided);
    assert!(!rows[1].decided);
}

#[test]
fn dream_verify_batch_rechecks_project_status_revision_hash_and_ttl() {
    let (store, _dir, lease) = fixture();
    let mut rows = store.load_dream_verify(&identity()).unwrap();
    rows.extend(
        store
            .load_dream_verify(&VerifyIdentity {
                project: "foreign",
                ..identity()
            })
            .unwrap(),
    );
    store
        .with_context_conn_for_test(|tx| {
            tx.execute(
                "UPDATE memories SET normalized_hash='changed' WHERE id=1",
                [],
            )?;
            tx.execute("UPDATE memories SET status='archived' WHERE id=2", [])?;
            Ok(())
        })
        .unwrap();
    let accepted = store
        .commit_dream_verify(
            "project",
            &rows,
            VerifyBatchKind::Verify,
            100,
            |tx| require_tx(tx, &lease, 100),
            |_, rows| Ok(rows.len()),
        )
        .unwrap();
    assert_eq!(accepted, 0);
    store
        .with_context_conn_for_test(|tx| {
            tx.execute(
                "UPDATE memories SET normalized_hash=?1,expires_at=100 WHERE id=1",
                [&rows[0].memory.normalized_hash],
            )?;
            tx.execute(
                "UPDATE memories SET status='active',revision=revision+1 WHERE id=2",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store
            .commit_dream_verify(
                "project",
                &rows,
                VerifyBatchKind::Verify,
                100,
                |tx| require_tx(tx, &lease, 100),
                |_, rows| Ok(rows.len())
            )
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .commit_dream_verify(
                "project",
                &rows,
                VerifyBatchKind::Expiry,
                100,
                |tx| require_tx(tx, &lease, 100),
                |_, rows| Ok(rows.iter().map(|row| row.memory.id).collect::<Vec<_>>())
            )
            .unwrap(),
        [1]
    );
    store
        .with_context_conn_for_test(|tx| {
            tx.execute("UPDATE memories SET expires_at=101 WHERE id=1", [])?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store
            .commit_dream_verify(
                "project",
                &rows,
                VerifyBatchKind::Expiry,
                100,
                |tx| require_tx(tx, &lease, 100),
                |_, rows| Ok(rows.len())
            )
            .unwrap(),
        0
    );
}

#[test]
fn dream_verify_context_writer_rolls_back_callback_effects() {
    let (store, _dir, lease) = fixture();
    let rows = store.load_dream_verify(&identity()).unwrap();
    let result: Result<(), _> = store.commit_dream_verify(
        "project",
        &rows,
        VerifyBatchKind::Verify,
        100,
        |tx| require_tx(tx, &lease, 100),
        |tx, rows| {
            tx.execute(
                "UPDATE memories SET verified_at=100 WHERE id=?1",
                [rows[0].memory.id],
            )?;
            Err(rusqlite::Error::InvalidQuery)
        },
    );
    assert!(result.is_err());
    assert_eq!(
        store
            .with_context_read(|db| db.query_row(
                "SELECT COUNT(*) FROM memories WHERE verified_at IS NOT NULL",
                [],
                |row| row.get::<_, i64>(0)
            ))
            .unwrap(),
        0
    );
}

#[test]
fn dream_verify_refuses_when_memory_authority_belongs_elsewhere() {
    let (store, _dir, lease) = fixture();
    let rows = store.load_dream_verify(&identity()).unwrap();
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
        .commit_dream_verify(
            "project",
            &rows,
            VerifyBatchKind::Verify,
            100,
            |tx| require_tx(tx, &lease, 100),
            |_, _| -> rusqlite::Result<()> { panic!("unowned memory must not reach the applier") }
        )
        .is_err());
}
