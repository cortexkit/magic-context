use super::*;

#[test]
fn source_identity_matches_shared_ts_goldens() {
    let golden: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/plugin/src/features/magic-context/rescore-source-identity.goldens.json"
    )).unwrap();
    assert_eq!(golden["rubricVersion"], RESCORE_RUBRIC_VERSION);
    for vector in golden["vectors"].as_array().unwrap() {
        let source: Source = serde_json::from_value(vector["source"].clone()).unwrap();
        assert_eq!(
            source.identity(),
            vector["sha256"].as_str().unwrap(),
            "{}",
            vector["name"]
        );
    }
}

fn fixture() -> (tempfile::TempDir, McStore) {
    let dir = tempfile::tempdir().unwrap();
    let descriptor = cortexkit_store_types::StorageDescriptor {
        module_id: "magic-context-test".into(),
        storage_namespace: "mc_cache".into(),
        isolation: cortexkit_store_types::Isolation::Module,
        backend: cortexkit_store_types::StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into_owned(),
        },
    };
    let store = McStore::open_for_test(&descriptor).unwrap();
    store.install_score_schema_for_test().unwrap();
    store
        .replace_compartments(
            "ses",
            &[StoredCompartment {
                sequence: 1,
                start_message: 1,
                end_message: 1,
                start_message_id: "raw".into(),
                end_message_id: "raw".into(),
                title: "Original".into(),
                content: "P1".into(),
                p1: Some("P1".into()),
                importance: 50,
                created_at: 100,
                ..Default::default()
            }],
        )
        .unwrap();
    (dir, store)
}

#[test]
fn watermark_views_undo_and_source_change_never_modify_base_rows() {
    let (_dir, store) = fixture();
    let base = store.load_compartments("ses").unwrap();
    let revision = store.publish_score_for_test("ses", 1, 99).unwrap();
    assert_eq!(store.load_compartments("ses").unwrap(), base);
    let at_zero = store
        .load_compartment_score_snapshot("ses", ScoreSelector::AtWatermark(0))
        .unwrap();
    assert!(at_zero.importance_by_sequence.is_empty());
    let latest = store
        .load_compartment_score_snapshot("ses", ScoreSelector::Latest)
        .unwrap();
    assert_eq!(latest.watermark, 1);
    assert_eq!(latest.importance_by_sequence[&1], 99);
    assert_eq!(latest.compartments, base);
    store.with_context_conn_for_test(|tx| {
        tx.execute("INSERT INTO compartment_score_selections (session_id, compartment_id, sequence, origin)
                    SELECT 'ses', compartment_id, 2, 'undo' FROM compartment_score_revisions WHERE id = ?1", [revision])?;
        Ok(())
    }).unwrap();
    assert!(store
        .load_compartment_score_snapshot("ses", ScoreSelector::Latest)
        .unwrap()
        .importance_by_sequence
        .is_empty());
    assert_eq!(
        store
            .load_compartment_score_snapshot("ses", ScoreSelector::AtWatermark(1))
            .unwrap()
            .importance_by_sequence[&1],
        99
    );
    for column in ["title", "created_at", "importance", "start_block_index"] {
        store
            .with_context_conn_for_test(|tx| {
                let old: rusqlite::types::Value = tx.query_row(
                    &format!("SELECT {column} FROM compartments WHERE session_id = 'ses'"),
                    [],
                    |row| row.get(0),
                )?;
                tx.execute(
                    &format!("UPDATE compartments SET {column} = ?1 WHERE session_id = 'ses'"),
                    [rusqlite::types::Value::Integer(42)],
                )?;
                assert!(
                    score_view_tx(tx, "ses", ScoreSelector::AtWatermark(1))?
                        .0
                        .is_empty(),
                    "{column}"
                );
                tx.execute(
                    &format!("UPDATE compartments SET {column} = ?1 WHERE session_id = 'ses'"),
                    [old],
                )?;
                Ok(())
            })
            .unwrap();
    }
}

#[test]
fn base_selector_ignores_sidecars() {
    let (_dir, store) = fixture();
    store.publish_score_for_test("ses", 1, 99).unwrap();
    let base = store
        .load_compartment_score_snapshot("ses", ScoreSelector::Base)
        .unwrap();
    assert_eq!(base.watermark, 0);
    assert!(base.importance_by_sequence.is_empty());
}

#[test]
fn score_view_is_evaluated_in_the_base_rows_read_transaction() {
    use crate::{ContextDomain, SqliteContextDomain};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    struct PublishAfterSnapshot {
        inner: SqliteContextDomain,
        path: std::path::PathBuf,
        pending: AtomicBool,
    }
    impl ContextDomain for PublishAfterSnapshot {
        fn read(
            &self,
            read: &mut dyn FnMut(&Connection) -> rusqlite::Result<()>,
        ) -> Result<(), McStoreError> {
            self.inner.read(read)?;
            if self.pending.swap(false, Ordering::SeqCst) {
                Connection::open(&self.path).unwrap().execute(
                    "INSERT INTO compartment_score_selections
                     (session_id, compartment_id, sequence, revision_id, origin, job_id, batch_id, attempt_id)
                     SELECT session_id, compartment_id, 1, id, 'publication', job_id, batch_id, attempt_id
                     FROM compartment_score_revisions", [],
                ).unwrap();
            }
            Ok(())
        }
        fn write(
            &self,
            tables: &[&str],
            write: &mut dyn FnMut(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
        ) -> Result<(), McStoreError> {
            self.inner.write(tables, write)
        }
        fn status(&self) -> serde_json::Value {
            self.inner.status()
        }
    }
    let (dir, store) = fixture();
    store.publish_score_for_test("ses", 1, 99).unwrap();
    store
        .with_context_conn_for_test(|tx| {
            tx.execute_batch("DELETE FROM compartment_score_selections")
        })
        .unwrap();
    let path = dir.path().join("context.db");
    store.install_context_domain(Arc::new(PublishAfterSnapshot {
        inner: SqliteContextDomain::open(&path).unwrap(),
        path,
        pending: AtomicBool::new(true),
    }));
    let snapshot = store
        .load_compartment_score_snapshot("ses", ScoreSelector::Latest)
        .unwrap();
    assert_eq!(snapshot.watermark, 0);
    assert!(snapshot.importance_by_sequence.is_empty());
    let latest = store
        .load_compartment_score_snapshot("ses", ScoreSelector::Latest)
        .unwrap();
    assert_eq!(latest.watermark, 1);
    assert_eq!(latest.importance_by_sequence[&1], 99);
}

/// For every store.db schema version from the fence to the newest one, a nonzero
/// applied score watermark survives a metadata-only rewrite and reopen next to
/// unchanged m0 bytes, and openers that stop at v63-v66 (older ck-mc builds) are
/// refused without touching the file. Keep this loop when the newest migration
/// advances: every future build must also keep the watermark.
#[test]
fn supported_store_fences_round_trip_applied_score_watermark_with_frozen_head() {
    use crate::{LATEST_MIGRATION_VERSION, SCORE_SELECTION_WATERMARK_STORE_FENCE};
    const { assert!(LATEST_MIGRATION_VERSION >= SCORE_SELECTION_WATERMARK_STORE_FENCE) };
    for ceiling in SCORE_SELECTION_WATERMARK_STORE_FENCE..=LATEST_MIGRATION_VERSION {
        let dir = tempfile::tempdir().unwrap();
        let descriptor = cortexkit_store_types::StorageDescriptor {
            module_id: "magic-context-test".into(),
            storage_namespace: "mc_cache".into(),
            isolation: cortexkit_store_types::Isolation::Module,
            backend: cortexkit_store_types::StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        };
        let mut core = cortexkit_cache_core::CoreState::default();
        core.frozen_units.push(cortexkit_cache_core::FrozenUnit {
            key: "m0".into(),
            kind: "history".into(),
            frozen_payload: "already served at selection 17".into(),
            durability_class: cortexkit_cache_core::DurabilityClass::Lineage,
            reset_rule: String::new(),
        });
        {
            let store = McStore::open_with_schema_ceiling_for_test(&descriptor, ceiling).unwrap();
            assert_eq!(store.module_store_schema_version().unwrap(), ceiling);
            let meta = crate::ModuleMeta {
                score_selection_watermark: 17,
                ..Default::default()
            };
            store.commit("scored", None, &core, &meta).unwrap();
        }
        // A metadata-only update by a build that knows this schema must keep the
        // watermark, because the m0 bytes it leaves untouched were rendered at it.
        {
            let store = McStore::open_with_schema_ceiling_for_test(&descriptor, ceiling).unwrap();
            let mut loaded = store.load("scored").unwrap();
            assert_eq!(loaded.meta.score_selection_watermark, 17);
            loaded.meta.guidance_date = "metadata rewrite".into();
            store
                .commit_meta("scored", loaded.row_version, &loaded.meta)
                .unwrap();
        }
        let before = std::fs::read(dir.path().join("store.db")).unwrap();
        for excluded_ceiling in [63, 64, 65, 66] {
            let Err(refusal) =
                McStore::open_with_schema_ceiling_for_test(&descriptor, excluded_ceiling)
            else {
                panic!("an excluded old writer opened a scored head at fence {ceiling}");
            };
            assert!(matches!(refusal, crate::McStoreError::StoreAheadOfBinary {
                db_version, binary_max,
            } if db_version == ceiling && binary_max == excluded_ceiling));
        }
        assert_eq!(std::fs::read(dir.path().join("store.db")).unwrap(), before);
        let store = McStore::open_with_schema_ceiling_for_test(&descriptor, ceiling).unwrap();
        let loaded = store.load("scored").unwrap();
        assert_eq!(loaded.meta.score_selection_watermark, 17);
        assert_eq!(loaded.core.frozen_units, core.frozen_units);
        let raw_meta = store
            .inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT meta FROM mc_cache_state WHERE session_id = 'scored'",
                    [],
                    |row| row.get::<_, String>(0),
                )
            })
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&raw_meta).unwrap()
                ["score_selection_watermark"],
            17
        );
    }
}
