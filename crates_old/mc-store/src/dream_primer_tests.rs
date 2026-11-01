use super::*;

#[test]
fn dream_primer_pending_vectors_include_wrong_model_but_not_current_model() {
    let rows = vec![
        json!({"id":1,"questionEmbedding":null,"questionEmbeddingModelId":"active"}),
        json!({"id":2,"questionEmbedding":[1.0],"questionEmbeddingModelId":"old"}),
        json!({"id":3,"questionEmbedding":[1.0],"questionEmbeddingModelId":"active"}),
    ];
    let snapshot = PrimerSnapshot {
        project: "project".into(),
        candidates: rows.clone(),
        primers: rows,
        compartments: Vec::new(),
        input_hash: String::new(),
    };
    assert_eq!(snapshot.pending_vectors("active"), (vec![1, 2], vec![1, 2]));
}

#[test]
fn dream_primer_vectors_use_float32_little_endian_and_reject_invalid_values() {
    assert_eq!(
        vector_blob(&[1.0, -0.5]).unwrap(),
        vec![0, 0, 128, 63, 0, 0, 0, 191]
    );
    assert!(vector_blob(&[]).is_err());
    assert!(vector_blob(&[f32::NAN]).is_err());
    assert!(vector_blob(&[f32::INFINITY]).is_err());
}

fn fixture() -> (McStore, tempfile::TempDir) {
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    let root = std::env::temp_dir().join("magic-context/i5-5d");
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
        tx.execute("INSERT INTO primer_candidates(id,project_path,harness,session_id,question,normalized_question,source_start_message_id,source_end_message_id,source_message_time,created_at) VALUES (1,'project','opencode','source','Question','question','m1','m2',1,1)",[])?;
        tx.execute("INSERT INTO primers(id,project_path,question,created_at,updated_at) VALUES (1,'project','Question?',1,1),(2,'foreign','Foreign?',1,1)",[])?;
        Ok(())
    }).unwrap();
    (store, dir)
}

fn answer(project: &str, id: i64) -> AnswerWrite {
    AnswerWrite {
        project_path: project.into(),
        primer_id: id,
        answer: "New answer".into(),
        answer_refreshed_at: 20,
        updated_at: 20,
    }
}

#[test]
fn dream_primer_foreign_batch_project_is_refused() {
    let (store, _dir) = fixture();
    let expected = store.load_dream_primers("project").unwrap();
    let batch = PromotionWrite {
        project_path: "foreign".into(),
        pruned_candidate_ids: vec![1],
        embedding_updates: vec![],
        writes: vec![],
    };
    assert!(store
        .commit_dream_primer_promotion(&expected, &batch, &[], |_| Ok(()))
        .is_err());
    assert!(store
        .commit_dream_primer_answer(&expected, &answer("foreign", 1), |_| Ok(()))
        .is_err());
    assert!(store
        .commit_dream_primer_answer(&expected, &answer("project", 2), |_| Ok(()))
        .is_err());
    assert_eq!(
        store.load_dream_primers("project").unwrap().input_hash,
        expected.input_hash
    );
}

#[test]
fn dream_primer_snapshot_replay_and_primer_hash_drift_are_refused() {
    let (store, _dir) = fixture();
    let expected = store.load_dream_primers("project").unwrap();
    store
        .commit_dream_primer_answer(&expected, &answer("project", 1), |_| Ok(()))
        .unwrap();
    let after = store.load_dream_primers("project").unwrap().input_hash;
    assert!(store
        .commit_dream_primer_answer(&expected, &answer("project", 1), |_| Ok(()))
        .is_err());
    assert_eq!(
        store.load_dream_primers("project").unwrap().input_hash,
        after
    );
    let expected = store.load_dream_primers("project").unwrap();
    store
        .with_context_conn_for_test(|tx| {
            tx.execute(
                "UPDATE primers SET question='Changed while refreshing' WHERE id=1",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    assert!(store
        .commit_dream_primer_answer(&expected, &answer("project", 1), |_| Ok(()))
        .is_err());
}
