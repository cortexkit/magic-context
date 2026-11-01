use super::*;

fn cache_digest(store: &McStore, namespace: &str) -> String {
    let loaded = store.load(namespace).unwrap();
    mc_store::engine_cache_digest(&loaded.core, &loaded.meta).unwrap()
}

#[tokio::test]
async fn engine_receipt_and_transport_view_failures_preserve_held_work() {
    for fail_engine in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let (rig, applied) = held_drops(dir.path()).await;
        let pending = rig.pending_targets();
        let served = rig.get(applied).await;
        closing_mismatch(&rig).await;
        rig.runner.entries.lock().unwrap().push(entry(
            40,
            "user",
            json!({"type":"text","text":"append after the mismatch"}),
            "next-run",
        ));
        let expected = request_bytes(&rig, &served);
        let store = rig.h.store.get().unwrap();
        let mut state = load(store, &rig.reference).unwrap().unwrap();
        rig.h
            .read_async(&mut state, 0, Duration::from_secs(10))
            .await
            .unwrap();
        state.resync = false;
        state.ingest_read(store, codec::Codec::OwnedBroca).unwrap();
        let namespace = state.namespace();
        let before = cache_digest(store, &namespace);
        let old_receipt =
            serde_json::to_value(store.load_async_cache_receipt(&rig.reference).unwrap()).unwrap();
        let conn = rusqlite::Connection::open(dir.path().join("store.db")).unwrap();
        if fail_engine {
            mc_store::cache_codec::fail_next_commit_after_section_writes();
        } else {
            conn.execute_batch("CREATE TRIGGER interrupt_transport_view BEFORE INSERT ON mc_cache_sections WHEN NEW.section GLOB '__ckmc_async_v2_view:*' BEGIN SELECT RAISE(ABORT,'transport view interrupted'); END").unwrap();
        }
        assert!(rig
            .h
            .publish_async(0, &mut state, codec::Codec::OwnedBroca, false)
            .is_err());
        drop(state);
        let after = cache_digest(store, &namespace);
        if fail_engine {
            assert_eq!(before, after, "engine CAS abort must roll back cache rows");
            assert_eq!(
                serde_json::to_value(store.load_async_cache_receipt(&rig.reference).unwrap())
                    .unwrap(),
                old_receipt,
                "the receipt must roll back with the cache"
            );
        } else {
            conn.execute_batch("DROP TRIGGER interrupt_transport_view")
                .unwrap();
            assert_ne!(
                before, after,
                "the engine committed before view publication failed"
            );
            let receipt = store
                .load_async_cache_receipt(&rig.reference)
                .unwrap()
                .unwrap();
            assert_eq!(receipt.namespace, namespace);
            assert_eq!(
                receipt.cache_digest, after,
                "receipt must describe the accepted cache"
            );
            assert_eq!(receipt.checkpoint["replay_safe"], true);
        }
        drop(conn);
        rig.h.resident_cache().forget(&rig.reference);
        rig.notice(4, 8_000, Some(applied)).await;
        assert_eq!(rig.pending_targets(), pending, "fail_engine={fail_engine}");
        assert_eq!(
            request_bytes(&rig, &rig.get(rig.newest().unwrap()).await),
            expected
        );
        assert!(!last_decision(&rig).contains("+rebuild"));
    }
}

#[tokio::test]
async fn durable_reissue_snapshot_keeps_unacknowledged_decisions_as_references() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, applied) = held_drops(dir.path()).await;
    let produced = rig.ride("ceiling").await.unwrap().view_version;
    closing_mismatch(&rig).await;
    let store = rig.h.store.get().unwrap();
    let mut state = load(store, &rig.reference).unwrap().unwrap();
    rig.h
        .read_async(&mut state, 0, Duration::from_secs(10))
        .await
        .unwrap();
    state.resync = false;
    state.ingest_read(store, codec::Codec::OwnedBroca).unwrap();
    let reissued = rig
        .h
        .publish_async(0, &mut state, codec::Codec::OwnedBroca, false)
        .unwrap()
        .unwrap();
    let (_, _, engine, _) = store
        .load_async_compaction_views(&rig.reference)
        .unwrap()
        .0
        .into_iter()
        .find(|(version, _, _, _)| *version == reissued.view_version)
        .unwrap();
    let snapshot: Value =
        serde_json::from_str::<Value>(&engine.unwrap()).unwrap()["engine_cache_snapshot"].clone();
    assert!(
        serde_json::to_vec(&snapshot).unwrap().len() < 4_096,
        "published baselines must be referenced rather than duplicated"
    );
    assert_eq!(snapshot["produced"], json!({"Published": produced}));
    assert_eq!(snapshot["applied"], json!({"Published": applied}));
    assert!(snapshot["engine"].get("last_produced").is_none());
    assert!(snapshot["engine"].get("last_applied").is_none());
    drop(state);
    rig.h.resident_cache().forget(&rig.reference);
    let recovered = load(store, &rig.reference).unwrap().unwrap();
    assert_eq!(
        recovered
            .produced_view
            .as_ref()
            .unwrap()
            .publication_version,
        Some(produced)
    );
    assert_eq!(
        recovered.applied_view.as_ref().unwrap().publication_version,
        Some(applied)
    );
    assert!(!recovered.resync_replay_pending);
}

#[tokio::test]
async fn published_baseline_retention_advances_when_placed_references_move_on() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, applied) = held_drops(dir.path()).await;
    let produced = rig.ride("ceiling").await.unwrap().view_version;
    closing_mismatch(&rig).await;
    rig.notice(4, 8_000, Some(applied)).await;
    let first_reissue = rig.newest().unwrap();
    rig.notice(5, 8_000, Some(produced)).await;
    rig.notice(6, 8_000, Some(first_reissue)).await;

    let store = rig.h.store.get().unwrap();
    let state = rig.state();
    assert_eq!(state.engine_baselines.produced, Baseline::Stored);
    assert_eq!(
        state.produced_view.as_ref().unwrap().publication_version,
        Some(produced)
    );
    assert!(state.applied.unwrap() > produced);
    assert!(store
        .load_async_compaction_view(&rig.reference, produced)
        .unwrap()
        .is_some());

    // A real rebuild replaces the produced decision; its acknowledgement
    // replaces the applied baseline, releasing the old publication dependency.
    let replacement = rig.ride("ceiling").await.unwrap().view_version;
    assert!(replacement > first_reissue);
    rig.notice(7, 8_000, Some(replacement)).await;
    let state = rig.state();
    assert_eq!(state.applied, Some(replacement));
    for baseline in [&state.produced_view, &state.applied_view] {
        assert_eq!(
            baseline.as_ref().unwrap().publication_version,
            Some(replacement)
        );
    }
    assert!(store
        .load_async_compaction_view(&rig.reference, produced)
        .unwrap()
        .is_none());
    assert!(store
        .load_async_compaction_view(&rig.reference, replacement)
        .unwrap()
        .is_some());
}
