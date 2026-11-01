use super::*;
use crate::dream_domain::require_tx;
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

fn fixture() -> (McStore, tempfile::TempDir) {
    let root = std::env::temp_dir().join("magic-context/i5-5e");
    std::fs::create_dir_all(&root).unwrap();
    let dir = tempfile::Builder::new()
        .prefix("dream_retrospective-store-")
        .tempdir_in(root)
        .unwrap();
    let store = McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into_owned(),
        },
    })
    .unwrap();
    (store, dir)
}

#[test]
fn dream_retrospective_rechecks_checkpoint_and_processed_window_on_writer() {
    let (store, _dir) = fixture();
    let lease = store
        .acquire_dream_domain("memory:project", "holder", 10)
        .unwrap()
        .unwrap();
    let expected = RetrospectiveState::default();
    let batch = RetrospectiveCommit {
        project: "project",
        expected: &expected,
        watermark_ms: 20,
        window_key: Some("window"),
        task_state_json: None,
        now_ms: 30,
        observations: &[],
    };
    store
        .with_context_conn_for_test(|tx| {
            tx.execute(
                "INSERT INTO retrospective_processed_windows VALUES('project','window',1)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    assert!(!store
        .commit_dream_retrospective(
            &batch,
            |tx| require_tx(tx, &lease, 30),
            |_| panic!("processed window must not reach effects")
        )
        .unwrap());
    store.with_context_conn_for_test(|tx| {
        tx.execute("DELETE FROM retrospective_processed_windows", [])?;
        tx.execute("INSERT INTO task_schedule_state(project_path,task,retrospective_watermark_ms) VALUES('project','retrospective',19)", [])?;
        Ok(())
    }).unwrap();
    assert!(!store
        .commit_dream_retrospective(
            &batch,
            |tx| require_tx(tx, &lease, 30),
            |_| panic!("stale checkpoint must not reach effects")
        )
        .unwrap());
    assert_eq!(
        store
            .load_dream_retrospective("project")
            .unwrap()
            .state
            .watermark_ms,
        19
    );
}

#[test]
fn dream_retrospective_final_checkpoint_failure_rolls_back_observations() {
    let (store, _dir) = fixture();
    let lease = store
        .acquire_dream_domain("memory:project", "holder", 10)
        .unwrap()
        .unwrap();
    store.with_context_conn_for_test(|tx| tx.execute_batch("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON task_schedule_state BEGIN SELECT RAISE(ABORT,'checkpoint failed'); END;")).unwrap();
    let expected = RetrospectiveState::default();
    let observations = [Observation {
        content: "Prefers bounded changes".into(),
        session_id: "source".into(),
    }];
    let batch = RetrospectiveCommit {
        project: "project",
        expected: &expected,
        watermark_ms: 20,
        window_key: Some("window"),
        task_state_json: Some("{}"),
        now_ms: 30,
        observations: &observations,
    };
    assert!(store
        .commit_dream_retrospective(&batch, |tx| require_tx(tx, &lease, 30), |_| Ok(()))
        .is_err());
    assert!(store
        .load_dream_user_review()
        .unwrap()
        .candidates
        .is_empty());
    let after = store.load_dream_retrospective("project").unwrap();
    assert_eq!(after.state, expected);
    assert!(after.processed_windows.is_empty());
}

/// A reviewer answer naming a candidate the pool does not hold commits as the
/// TypeScript reviewer does: the id is kept in source_candidate_ids with null
/// provenance and consuming it deletes nothing. A snapshot that changed after
/// the model ran is still refused.
#[test]
fn dream_retrospective_review_refuses_stale_snapshots_and_ignores_unknown_ids() {
    let (store, _dir) = fixture();
    let lease = store
        .acquire_dream_domain("user-memories", "holder", 10)
        .unwrap()
        .unwrap();
    store.with_context_conn_for_test(|tx| {
        tx.execute("INSERT INTO user_memory_candidates(content,session_id,created_at) VALUES('Prefers checks','source',1)", [])?;
        Ok(())
    }).unwrap();
    let snapshot = store.load_dream_user_review().unwrap();
    let promotions = [UserPromotion {
        content: "Prefers checks".into(),
        candidate_ids: vec![999],
    }];
    let batch = ReviewCommit {
        expected: &snapshot,
        decision_key: "review",
        now_ms: 30,
        promotions: &promotions,
        updates: &[],
        dismissals: &[],
        consume_candidate_ids: &[999],
    };
    store
        .with_context_conn_for_test(|tx| {
            tx.execute("UPDATE user_memory_candidates SET content='Changed'", [])?;
            Ok(())
        })
        .unwrap();
    assert!(!store
        .commit_dream_user_review(&batch, |tx| require_tx(tx, &lease, 30))
        .unwrap());
    assert!(store.load_dream_user_review().unwrap().profiles.is_empty());
    let snapshot = store.load_dream_user_review().unwrap();
    let batch = ReviewCommit {
        expected: &snapshot,
        ..batch
    };
    assert!(store
        .commit_dream_user_review(&batch, |tx| require_tx(tx, &lease, 30))
        .unwrap());
    let after = store.load_dream_user_review().unwrap();
    assert_eq!(after.candidates, snapshot.candidates);
    assert_eq!(after.profiles.len(), 1);
    assert_eq!(after.profiles[0].source_candidate_ids, "[999]");
    assert_eq!(after.profiles[0].source_candidate_provenance, None);
}

#[test]
fn dream_retrospective_review_journal_failure_restores_candidate_and_profile() {
    let (store, _dir) = fixture();
    let lease = store
        .acquire_dream_domain("user-memories", "holder", 10)
        .unwrap()
        .unwrap();
    store.with_context_conn_for_test(|tx| {
        tx.execute("INSERT INTO user_memory_candidates(content,session_id,created_at) VALUES('Prefers checks','source',1)", [])?;
        tx.execute_batch("CREATE TRIGGER fail_journal BEFORE INSERT ON memory_journal BEGIN SELECT RAISE(ABORT,'journal failed'); END;")
    }).unwrap();
    let snapshot = store.load_dream_user_review().unwrap();
    let promotions = [UserPromotion {
        content: "Prefers checks".into(),
        candidate_ids: vec![1],
    }];
    let batch = ReviewCommit {
        expected: &snapshot,
        decision_key: "review",
        now_ms: 30,
        promotions: &promotions,
        updates: &[],
        dismissals: &[],
        consume_candidate_ids: &[1],
    };
    assert!(store
        .commit_dream_user_review(&batch, |tx| require_tx(tx, &lease, 30))
        .is_err());
    assert_eq!(store.load_dream_user_review().unwrap(), snapshot);
    assert_eq!(store.user_profile_version().unwrap(), 0);
}
