use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_core::CoreState;
use mc_store::{McStore, McStoreError, ModuleMeta};

fn descriptor(path: &std::path::Path) -> StorageDescriptor {
    StorageDescriptor {
        module_id: "mc-module-boundary-counter-test".to_string(),
        storage_namespace: "mc_cache".to_string(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: path.join("store.db").to_string_lossy().to_string(),
        },
    }
}

#[test]
fn competing_module_passes_keep_one_increment_and_reopen_keeps_it() {
    let directory = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&descriptor(directory.path())).unwrap();
    let session = "module-counter";
    let core = CoreState::default();
    let initial = ModuleMeta::default();
    store.commit(session, None, &core, &initial).unwrap();

    let winner = store.load(session).unwrap();
    let loser = store.load(session).unwrap();
    let mut winner_meta = winner.meta.clone();
    winner_meta.boundary_divergence_pending_count = 1;
    store
        .commit(session, winner.row_version, &winner.core, &winner_meta)
        .unwrap();

    let mut loser_meta = loser.meta.clone();
    loser_meta.boundary_divergence_pending_count = 1;
    assert!(matches!(
        store.commit(session, loser.row_version, &loser.core, &loser_meta),
        Err(McStoreError::CasConflict {
            expected: Some(1),
            found: 2
        })
    ));
    assert_eq!(
        store
            .load(session)
            .unwrap()
            .meta
            .boundary_divergence_pending_count,
        1
    );

    drop(store);
    let reopened = McStore::open_for_test(&descriptor(directory.path())).unwrap();
    assert_eq!(
        reopened
            .load(session)
            .unwrap()
            .meta
            .boundary_divergence_pending_count,
        1
    );
}
