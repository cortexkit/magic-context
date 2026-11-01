use super::*;
use crate::recomp_staging::{Compartment, Fact, Rows, StagedCompartment};
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use std::sync::Arc;

fn fixture() -> (McStore, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let context_path = dir.path().join("context.db");
    let db = rusqlite::Connection::open(&context_path).unwrap();
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
    store.install_context_domain(Arc::new(
        crate::SqliteContextDomain::open(&context_path).unwrap(),
    ));
    (store, dir)
}

#[test]
fn drain_transactions_create_rollback_and_preserve_unrelated_state() {
    let (store, _dir) = fixture();
    assert!(store
        .update_drain_meta::<()>("new", |meta| {
            meta.protected_tail_drain_tokens = 12.0;
            Err(rusqlite::Error::InvalidQuery)
        })
        .is_err());
    assert_eq!(
        store
            .context_read(
                |db| db.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r
                    .get::<_, i64>(0))
            )
            .unwrap(),
        0
    );
    store.context_write(&["session_meta"], |tx| {
        tx.execute("INSERT INTO session_meta(session_id, served_prefix, protected_tail_drain_tokens) VALUES ('ses','frozen',7)", [])?;
        tx.execute("INSERT INTO session_meta(session_id, served_prefix, protected_tail_drain_tokens) VALUES ('foreign','other',99)", [])?;
        Ok(())
    }).unwrap();
    let old = store
        .update_drain_meta("ses", |meta| {
            let old = *meta;
            meta.protected_tail_drain_tokens += 10.0;
            meta.protected_tail_drain_window_started_at = 100;
            meta.emergency_drain_active = 101;
            meta.historian_drain_failure_at = 102;
            Ok(old)
        })
        .unwrap();
    assert_eq!(old.protected_tail_drain_tokens, 7.0);
    let saved = store.update_drain_meta("ses", |meta| Ok(*meta)).unwrap();
    assert_eq!(
        saved,
        DrainMeta {
            protected_tail_drain_tokens: 17.0,
            protected_tail_drain_window_started_at: 100,
            emergency_drain_active: 101,
            historian_drain_failure_at: 102
        }
    );
    assert_eq!(
        store
            .context_read(|db| db.query_row(
                "SELECT served_prefix FROM session_meta WHERE session_id='ses'",
                [],
                |r| r.get::<_, String>(0)
            ))
            .unwrap(),
        "frozen"
    );
    assert_eq!(
        store
            .update_drain_meta("foreign", |meta| Ok(meta.protected_tail_drain_tokens))
            .unwrap(),
        99.0
    );
    assert!(store
        .update_drain_meta("ses", |meta| {
            meta.protected_tail_drain_tokens = f64::INFINITY;
            Ok(())
        })
        .is_err());
    assert_eq!(
        store.update_drain_meta("ses", |meta| Ok(*meta)).unwrap(),
        saved
    );
}

#[test]
fn drain_transactions_serialize_concurrent_reservations() {
    let (store, _dir) = fixture();
    let store = Arc::new(store);
    std::thread::scope(|scope| {
        for _ in 0..4 {
            let store = store.clone();
            scope.spawn(move || {
                for _ in 0..10 {
                    store
                        .update_drain_meta("ses", |meta| {
                            meta.protected_tail_drain_tokens += 1.0;
                            Ok(())
                        })
                        .unwrap();
                }
            });
        }
    });
    assert_eq!(
        store
            .update_drain_meta("ses", |meta| Ok(meta.protected_tail_drain_tokens))
            .unwrap(),
        40.0
    );
}

#[test]
fn shared_compartment_lease_renewal_cannot_steal_or_resurrect_a_hold() {
    let (store, _dir) = fixture();
    assert!(store
        .acquire_compartment_lease("ses", "ts-wrapup", 100)
        .unwrap());
    assert!(!store
        .acquire_compartment_lease("ses", "rust-recomp", 101)
        .unwrap());
    assert!(!store
        .renew_compartment_lease("ses", "rust-recomp", 102)
        .unwrap());
    assert!(store
        .renew_compartment_lease("ses", "ts-wrapup", 200)
        .unwrap());
    assert!(store
        .owns_compartment_lease("ses", "ts-wrapup", COMPARTMENT_LEASE_TTL_MS + 150)
        .unwrap());
    store
        .release_compartment_lease("ses", "rust-recomp")
        .unwrap();
    assert!(store
        .owns_compartment_lease("ses", "ts-wrapup", 201)
        .unwrap());
    assert!(!store
        .renew_compartment_lease("ses", "ts-wrapup", COMPARTMENT_LEASE_TTL_MS + 200)
        .unwrap());
    assert!(store
        .acquire_compartment_lease("ses", "rust-recomp", COMPARTMENT_LEASE_TTL_MS + 201)
        .unwrap());
    assert!(!store
        .renew_compartment_lease("ses", "ts-wrapup", COMPARTMENT_LEASE_TTL_MS + 202)
        .unwrap());
    store.release_compartment_lease("ses", "ts-wrapup").unwrap();
    assert!(store
        .owns_compartment_lease("ses", "rust-recomp", COMPARTMENT_LEASE_TTL_MS + 203)
        .unwrap());
}

#[cfg(unix)]
#[test]
fn shared_compartment_lease_reclaims_only_a_proven_dead_owner() {
    let (store, _dir) = fixture();
    assert!(store.acquire_compartment_lease("ses", "old", 100).unwrap());
    store
        .context_write(&["compartment_state_lease"], |tx| {
            tx.execute(
                "UPDATE compartment_state_lease SET owner_pid=NULL WHERE session_id='ses'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    assert!(!store.acquire_compartment_lease("ses", "rust", 101).unwrap());
    store
        .context_write(&["compartment_state_lease"], |tx| {
            tx.execute(
                "UPDATE compartment_state_lease SET owner_pid=?1 WHERE session_id='ses'",
                [i32::MAX],
            )?;
            Ok(())
        })
        .unwrap();
    assert!(store.acquire_compartment_lease("ses", "rust", 102).unwrap());
    assert!(store.owns_compartment_lease("ses", "rust", 103).unwrap());
}

fn staged() -> Rows {
    Rows {
        compartments: [(
            1,
            StagedCompartment {
                compartment: Compartment {
                    sequence: 1,
                    start_message: 1,
                    end_message: 3,
                    start_message_id: "m1".into(),
                    end_message_id: "m3".into(),
                    start_block_index: Some(0),
                    end_block_index: Some(2),
                    title: "title".into(),
                    content: "body".into(),
                    p1: Some("p1".into()),
                    p2: None,
                    p3: None,
                    p4: None,
                    importance: 73,
                    episode_type: Some("work".into()),
                },
                pass_number: 2,
            },
        )]
        .into(),
        facts: vec![Fact {
            category: "PROJECT".into(),
            content: "fact".into(),
        }],
    }
}

#[test]
fn recomp_staging_is_atomic_scoped_restartable_and_lease_fenced() {
    let (store, dir) = fixture();
    assert!(store.acquire_compartment_lease("ses", "rust", 100).unwrap());
    store
        .update_recomp_staging("pi", "ses", "rust", 101, |rows| {
            *rows = staged();
            Ok(())
        })
        .unwrap();
    assert_eq!(store.load_recomp_staging("pi", "ses").unwrap(), staged());
    store.context_write(&["recomp_compartments"], |tx| {
        tx.execute("UPDATE recomp_compartments SET created_at=42,rebase_status='needs_rebase' WHERE harness='pi' AND session_id='ses'", [])?;
        Ok(())
    }).unwrap();
    let metadata = || {
        store.context_read(|db| db.query_row("SELECT id,created_at,rebase_status FROM recomp_compartments WHERE harness='pi' AND session_id='ses'", [], |r| Ok((r.get::<_, i64>(0)?,r.get::<_, i64>(1)?,r.get::<_, String>(2)?)))).unwrap()
    };
    let previous = metadata();
    store
        .update_recomp_staging("pi", "ses", "rust", 102, |_| Ok(()))
        .unwrap();
    assert_eq!(metadata(), previous);
    assert_eq!(
        store.load_recomp_staging("other", "ses").unwrap(),
        Rows::default()
    );
    assert_eq!(
        store.load_recomp_staging("pi", "foreign").unwrap(),
        Rows::default()
    );
    assert!(store
        .update_recomp_staging::<()>("pi", "ses", "rust", 102, |rows| {
            rows.facts.clear();
            Err(rusqlite::Error::InvalidQuery)
        })
        .is_err());
    assert!(store
        .update_recomp_staging("pi", "ses", "wrong", 102, |rows| {
            *rows = Rows::default();
            Ok(())
        })
        .is_err());
    assert!(store
        .update_recomp_staging(
            "pi",
            "ses",
            "rust",
            COMPARTMENT_LEASE_TTL_MS + 100,
            |rows| {
                *rows = Rows::default();
                Ok(())
            }
        )
        .is_err());
    // The legacy uniqueness key cannot hold another harness at this sequence.
    // Reject that collision without deleting either harness's existing facts.
    assert!(store
        .update_recomp_staging("other", "ses", "rust", 103, |rows| {
            *rows = staged();
            Ok(())
        })
        .is_err());
    assert_eq!(store.load_recomp_staging("pi", "ses").unwrap(), staged());
    assert_eq!(
        store.load_recomp_staging("other", "ses").unwrap(),
        Rows::default()
    );
    drop(store);
    let db = rusqlite::Connection::open(dir.path().join("context.db")).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM recomp_compartments WHERE harness='pi'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM recomp_facts WHERE harness='pi'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM compartments", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
