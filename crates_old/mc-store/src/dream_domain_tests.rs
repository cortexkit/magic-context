use super::*;
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use std::sync::Arc;

fn fixture() -> (McStore, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        &include_str!("../testdata/context_schema/schema.sql").replace(":applied_at", "1"),
    )
    .unwrap();
    let store = McStore::open(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into_owned(),
        },
    })
    .unwrap();
    store.install_context_domain(Arc::new(crate::SqliteContextDomain::open(&path).unwrap()));
    (store, dir)
}

#[test]
fn domain_generations_fence_expiry_renewal_release_and_effect_transactions() {
    let (store, _dir) = fixture();
    let first = store
        .acquire_dream_domain("memory:p", "first", 100)
        .unwrap()
        .unwrap();
    assert_eq!(first.generation, 1);
    assert!(store
        .acquire_dream_domain("memory:p", "second", 101)
        .unwrap()
        .is_none());
    assert!(store.renew_dream_domain(&first, 200).unwrap());
    assert!(store.owns_dream_domain(&first, 120_199).unwrap());
    assert!(!store.renew_dream_domain(&first, 120_200).unwrap());
    let next = store
        .acquire_dream_domain("memory:p", "next", 120_200)
        .unwrap()
        .unwrap();
    assert_eq!(next.generation, 2);
    assert!(!store.release_dream_domain(&first).unwrap());
    assert!(!store.renew_dream_domain(&first, 120_201).unwrap());
    let result = store.context_write(&["dream_state"], |tx| {
        set(tx, "effect", "holder", "must-rollback")?;
        require_tx(tx, &first, 120_201)
    });
    assert!(result.is_err());
    assert!(store
        .context_read(|db| get(db, "effect", "holder"))
        .unwrap()
        .is_none());
    store
        .context_write(&["dream_state"], |tx| {
            require_tx(tx, &next, 120_201)?;
            set(tx, "effect", "holder", "accepted")
        })
        .unwrap();
    assert!(store.release_dream_domain(&next).unwrap());
    let third = store
        .acquire_dream_domain("memory:p", "third", 120_202)
        .unwrap()
        .unwrap();
    assert_eq!(third.generation, 3);
    assert!(store.owns_dream_domain(&third, 120_202).unwrap());
}

#[test]
fn legacy_names_independent_domains_and_reopen_use_existing_schema() {
    let (store, dir) = fixture();
    let legacy = store
        .acquire_dream_domain("dreaming", "legacy", 1)
        .unwrap()
        .unwrap();
    assert_eq!(
        store
            .context_read(|db| db.query_row(
                "SELECT value FROM dream_state WHERE key='dreaming_lease_holder'",
                [],
                |r| r.get::<_, String>(0)
            ))
            .unwrap(),
        "legacy"
    );
    let scoped = store
        .acquire_dream_domain("memory:p", "scoped", 1)
        .unwrap()
        .unwrap();
    assert!(store
        .acquire_dream_domain("memory:q", "foreign", 1)
        .unwrap()
        .is_some());
    drop(store);
    let db = Connection::open(dir.path().join("context.db")).unwrap();
    assert!(held(&db, &legacy, 2).unwrap());
    assert!(held(&db, &scoped, 2).unwrap());
    assert_eq!(generation(&db, "memory:p").unwrap(), 1);
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM dream_state WHERE key LIKE 'lease:dreaming:%'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn concurrent_dream_domain_claims_have_one_winner() {
    let (store, _dir) = fixture();
    let store = Arc::new(store);
    let winners = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let store = store.clone();
                scope.spawn(move || {
                    store
                        .acquire_dream_domain("user-memories", &format!("owner-{i}"), 1)
                        .unwrap()
                        .is_some()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap() as usize)
            .sum::<usize>()
    });
    assert_eq!(winners, 1);
}

fn timing_fixture() -> (McStore, tempfile::TempDir) {
    let base = std::env::temp_dir().join("magic-context/i5-c1");
    std::fs::create_dir_all(&base).unwrap();
    let dir = tempfile::tempdir_in(base).unwrap();
    let path = dir.path().join("context.db");
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            &include_str!("../testdata/context_schema/schema.sql").replace(":applied_at", "1"),
        )
        .unwrap();
    let store = McStore::open(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into_owned(),
        },
    })
    .unwrap();
    store.install_context_domain(Arc::new(crate::SqliteContextDomain::open(&path).unwrap()));
    (store, dir)
}

#[test]
fn domain_timing_reads_durable_renewal_and_release_without_new_rows() {
    let (store, _root) = timing_fixture();
    assert_eq!(store.dream_domain_timing("dreaming").unwrap(), None);
    let lease = store
        .acquire_dream_domain("dreaming", "owner", 100)
        .unwrap()
        .unwrap();
    let timing = store.dream_domain_timing("dreaming").unwrap().unwrap();
    assert_eq!(
        timing,
        DreamDomainTiming {
            holder: "owner".into(),
            generation: lease.generation,
            renewed_at_ms: 100,
            expires_at_ms: 120_100
        }
    );
    assert!(store.renew_dream_domain(&lease, 300).unwrap());
    let renewed = store.dream_domain_timing("dreaming").unwrap().unwrap();
    assert_eq!(renewed.renewed_at_ms, 300);
    assert_eq!(renewed.expires_at_ms, 120_300);
    assert!(store.release_dream_domain(&lease).unwrap());
    assert_eq!(store.dream_domain_timing("dreaming").unwrap(), None);
    assert_eq!(
        store.context_read(|db| generation(db, "dreaming")).unwrap(),
        lease.generation
    );
}

#[test]
fn domain_timing_refuses_corrupt_or_partial_lease_records() {
    let (store, _root) = timing_fixture();
    let lease = store
        .acquire_dream_domain("dreaming", "owner", 100)
        .unwrap()
        .unwrap();
    store
        .context_write(&["dream_state"], |tx| {
            set(tx, "dreaming", "heartbeat", "not-a-time")
        })
        .unwrap();
    assert!(store.dream_domain_timing("dreaming").is_err());
    assert!(store.release_dream_domain(&lease).unwrap());
    store
        .context_write(&["dream_state"], |tx| {
            set(tx, "dreaming", "heartbeat", "100")
        })
        .unwrap();
    assert!(store.dream_domain_timing("dreaming").is_err());
}
