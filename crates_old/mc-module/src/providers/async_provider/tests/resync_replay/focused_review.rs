use super::*;

#[tokio::test]
async fn durable_snapshot_never_references_a_pruned_produced_view() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, applied) = held_drops(dir.path()).await;
    let produced = rig.ride("ceiling").await.unwrap().view_version;
    closing_mismatch(&rig).await;
    rig.notice(4, 8_000, Some(applied)).await;
    let first_reissue = rig.newest().unwrap();
    rig.notice(5, 8_000, Some(produced)).await;
    assert!(rig.newest().unwrap() > first_reissue);
    rig.notice(6, 8_000, Some(first_reissue)).await;
    let latest = rig.newest().unwrap();
    let store = rig.h.store.get().unwrap();
    let (_, _, engine, _) = store
        .load_async_compaction_views(&rig.reference)
        .unwrap()
        .0
        .into_iter()
        .find(|(version, _, _, _)| *version == latest)
        .unwrap();
    let snapshot =
        serde_json::from_str::<Value>(&engine.unwrap()).unwrap()["engine_cache_snapshot"].clone();
    if let Some(version) = snapshot["produced"]["Published"].as_u64() {
        assert!(
            store
                .load_async_compaction_view(&rig.reference, version)
                .unwrap()
                .is_some(),
            "durable snapshot {latest} references missing produced baseline {version}: {snapshot}"
        );
    }
}

async fn interrupted_transport(dir: &Path) -> (Rig, State) {
    let (rig, _) = held_drops(dir).await;
    closing_mismatch(&rig).await;
    rig.runner.entries.lock().unwrap().push(entry(
        40,
        "user",
        json!({"type":"text","text":"new raw append"}),
        "next-run",
    ));
    let store = rig.h.store.get().unwrap();
    let mut state = load(store, &rig.reference).unwrap().unwrap();
    rig.h
        .read_async(&mut state, 0, Duration::from_secs(10))
        .await
        .unwrap();
    state.resync = false;
    state.ingest_read(store, codec::Codec::OwnedBroca).unwrap();
    let conn = rusqlite::Connection::open(dir.join("store.db")).unwrap();
    conn.execute_batch("CREATE TRIGGER interrupt_review_view BEFORE INSERT ON mc_cache_sections WHEN NEW.section GLOB '__ckmc_async_v2_view:*' BEGIN SELECT RAISE(ABORT,'review view interrupted'); END").unwrap();
    assert!(rig
        .h
        .publish_async(0, &mut state, codec::Codec::OwnedBroca, false)
        .is_err());
    (rig, state)
}

#[tokio::test]
async fn receipt_recovery_rejects_a_later_foreign_engine_commit() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, mut state) = interrupted_transport(dir.path()).await;
    let store = rig.h.store.get().unwrap();
    let receipt = store
        .load_async_cache_receipt(&rig.reference)
        .unwrap()
        .expect("non-authorizing pass receipt");
    assert_eq!(receipt.checkpoint["replay_safe"], true);
    let produced = state.produced_view.as_ref().unwrap().identity.clone();
    let applied = state.applied_view.as_ref().unwrap().identity.clone();
    let version = state.engine.version_high_water;
    state.engine_cache_witness = None;
    assert!(engine_cache::reconcile(store, &mut state).unwrap());
    assert_eq!(state.produced_view.as_ref().unwrap().identity, produced);
    assert_eq!(state.applied_view.as_ref().unwrap().identity, applied);
    assert_eq!(state.engine.version_high_water, version);

    // A different writer advances the cache without updating the adapter's
    // receipt. The older receipt must not explain the foreign cache contents.
    let mut loaded = store.load(&state.namespace()).unwrap();
    loaded.core.boundary_id.push_str("foreign-writer");
    store
        .commit(
            &state.namespace(),
            loaded.row_version,
            &loaded.core,
            &loaded.meta,
        )
        .unwrap();
    assert!(!engine_cache::reconcile(store, &mut state).unwrap());
}

#[tokio::test]
async fn authorizing_commit_removes_receipt_even_when_view_publication_fails() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, mut state) = interrupted_transport(dir.path()).await;
    let store = rig.h.store.get().unwrap();
    assert!(store
        .load_async_cache_receipt(&rig.reference)
        .unwrap()
        .is_some());
    assert!(rig
        .h
        .publish_async(0, &mut state, codec::Codec::OwnedBroca, true)
        .is_err());
    assert!(
        store
            .load_async_cache_receipt(&rig.reference)
            .unwrap()
            .is_none(),
        "a rebuilding pass cannot be justified by a non-authorizing receipt"
    );
    drop(state);
    rig.h.resident_cache().forget(&rig.reference);
    let mut durable = load(store, &rig.reference).unwrap().unwrap();
    assert!(
        !engine_cache::reconcile(store, &mut durable).unwrap(),
        "without a durable view the changed cache still requires a rebuild"
    );
}

#[tokio::test]
async fn durable_snapshot_recovery_keeps_a_later_acknowledgement_authoritative() {
    for acknowledge_produced in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (rig, applied) = held_drops(dir.path()).await;
        let produced = rig.ride("ceiling").await.unwrap();
        let applied_bytes = request_bytes(&rig, &rig.get(applied).await);
        let produced_bytes = request_bytes(&rig, &produced);
        assert_ne!(applied_bytes, produced_bytes);
        assert!(!produced.ranges.iter().any(|range| matches!(range,
            view::ViewRange::Keep { edits, .. } if edits.iter().any(|edit| edit.ordinal == 38 && edit.drop)
        )), "the new queued target must not already be dropped");
        rig.queue(&[214]).await;
        let pending = rig.pending_targets();
        assert!(!pending.is_empty());
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
        assert_eq!(request_bytes(&rig, &reissued), applied_bytes);
        // The engine and view are durable, but the record still describes the
        // state before publication, as it would after a process crash.
        drop(state);
        rig.h.resident_cache().forget(&rig.reference);
        let (ack, expected) = if acknowledge_produced {
            (produced.view_version, produced_bytes)
        } else {
            (reissued.view_version, applied_bytes)
        };
        rig.notice(4, 8_000, Some(ack)).await;
        let recovered = rig.state();
        assert_eq!(
            recovered.applied_view.unwrap().publication_version,
            Some(ack)
        );
        assert_eq!(rig.pending_targets(), pending);
        assert_eq!(
            request_bytes(&rig, &rig.get(rig.newest().unwrap()).await),
            expected
        );
        assert!(!last_decision(&rig).contains("+rebuild"));
    }
}
