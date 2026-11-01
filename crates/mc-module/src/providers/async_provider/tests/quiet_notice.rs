use super::*;

#[tokio::test]
async fn engine_cache_upgrade_reuses_matching_rows_and_rebuilds_mismatches() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    moved_session::settle_historian(&rig).await;
    rig.history(20, "engine consistency history");
    rig.notice(2, 1_000, None).await;
    moved_session::settle_historian(&rig).await;
    let store = rig.h.store.get().unwrap();
    let state = rig.state();
    assert!(
        engine_cache::matches(store, &state).unwrap(),
        "matching engine must survive upgrade without a rebuild"
    );
    let mut legacy = rig.state();
    legacy.engine_cache_witness = None;
    assert!(
        engine_cache::matches(store, &legacy).unwrap(),
        "legacy provider baselines must validate without an extra rebuild"
    );
    let epoch = state.engine.rebuild_epoch;
    let namespace = state.namespace();
    let loaded = store.load(&namespace).unwrap();
    let mut mismatched = loaded.meta.clone();
    mismatched.served_output_fingerprint[0].content_hash = "different-cache-pass".into();
    store
        .commit(&namespace, loaded.row_version, &loaded.core, &mismatched)
        .unwrap();
    assert!(
        !engine_cache::matches(store, &state).unwrap(),
        "a same-epoch cache mismatch must fail its witness"
    );
    assert!(
        !engine_cache::matches(store, &legacy).unwrap(),
        "legacy cache frames must agree with the moved provider view"
    );
    let current = store.load(&namespace).unwrap();
    store
        .commit(&namespace, current.row_version, &loaded.core, &loaded.meta)
        .unwrap();
    let loaded = store.load(&namespace).unwrap();
    let mut stale = loaded.meta;
    stale.last_render_config = stale.last_render_config.replace(
        &format!("|broca-compaction:{epoch}"),
        "|broca-compaction:99999",
    );
    store
        .commit(&namespace, loaded.row_version, &loaded.core, &stale)
        .unwrap();
    assert!(!engine_cache::matches(store, &state).unwrap());
    let mut working = state.engine_with_baselines().unwrap();
    let status = transform::compaction::Status {
        lineage_id: state.lineage.clone().unwrap(),
        newest_ordinal: state.entries.last_key_value().map(|(ordinal, _)| *ordinal),
        previous_usage: None,
        request_tokens: 1_000,
        context_window: 100_000,
        prefix_rebuilding: false,
        cold_prefix: false,
        pipeline_switch: false,
        last_applied_version: None,
        last_not_applied: None,
    };
    let binding = rig.h.async_binding(&state);
    rig.h
        .async_engine(
            7,
            &binding,
            &state,
            codec::Codec::OpencodeAiSdk,
            &status,
            &mut working,
        )
        .unwrap();
    assert_eq!(
        working.rebuild_epoch,
        epoch + 1,
        "stale engine must rebuild before producing output"
    );
}

#[tokio::test]
async fn undo_archive_replay_tracks_appends_and_reloads_pending_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(4);
    rig.notice(1, 1_000, None).await;
    moved_session::settle_historian(&rig).await;
    let store = rig.h.store.get().unwrap();
    let mut state = rig.state();
    let first = state.entries.first_key_value().unwrap().0.to_owned();
    let next = first + 1;
    let appended = Arc::clone(state.entries.get(&next).unwrap());
    let old_mid = state.entries.get(&first).unwrap().mid.clone();
    let new_mid = appended.mid.clone();
    state.entries.retain(|ordinal, _| *ordinal == first);
    let mut old_edits = frozen_edits::FrozenEdits::default();
    old_edits.insert_drop(&old_mid, "0", "old-digest");
    let mut new_edits = frozen_edits::FrozenEdits::default();
    new_edits.insert_drop(&new_mid, "0", "new-digest");
    let raw = store
        .load_async_compaction(&rig.reference)
        .unwrap()
        .unwrap();
    let key = state.key.store_key().conversation_key();
    let mut save = store.async_compaction_save(&rig.reference, &key, &state.key.session, &raw);
    save.baseline(
        format!("undo-native-edits:mid:{old_mid}"),
        Some(old_edits.json().unwrap()),
    );
    save.baseline(
        format!("undo-native-edits:mid:{new_mid}"),
        Some(new_edits.json().unwrap()),
    );
    save.commit().unwrap();
    state.pending_undo_edits = true;
    state.restore_undo_edits(store).unwrap();
    assert_eq!(state.undo_checked_through, Some(first));
    // A resident append must not reread an already merged archive. Corrupting
    // that old slot makes an accidental full-window replay fail visibly.
    let mut save = store.async_compaction_save(&rig.reference, &key, &state.key.session, &raw);
    save.baseline(
        format!("undo-native-edits:mid:{old_mid}"),
        Some("invalid archive".into()),
    );
    save.commit().unwrap();
    state.entries.insert(next, appended);
    state.pending_undo_edits = true;
    state.restore_undo_edits(store).unwrap();
    let merged = state.frozen_edits.json().unwrap();
    assert!(merged.contains(&old_mid));
    assert!(merged.contains(&new_mid));
    assert_eq!(state.undo_checked_through, Some(next));
    // The watermark is not durable: crash recovery must still inspect every
    // source when the record says an undo replay has not completed.
    let mut reloaded = load(store, &rig.reference).unwrap().unwrap();
    assert_eq!(reloaded.undo_checked_through, None);
    reloaded.pending_undo_edits = true;
    assert!(reloaded.restore_undo_edits(store).is_err());
}

#[tokio::test]
async fn unchanged_saves_leave_setup_and_move_payloads_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = moved_session::moved_rig(dir.path(), true).await;
    rig.notice(1, 1_000, None).await;
    moved_session::settle_historian(&rig).await;
    let store = rig.h.store.get().unwrap();
    let mut state = rig.state();
    let initial = state.initial.clone();
    let bound = state.standalone_move.as_ref().unwrap().bound_drops.clone();
    assert!(!bound.is_empty());
    assert_eq!(
        state.offline_first_pass.as_ref().unwrap().bound_generation,
        Some(state.generation)
    );
    let header = load_head(store, &rig.reference).unwrap().unwrap();
    assert!(
        header.initial.is_null(),
        "header reads must not hydrate the answer"
    );
    assert!(!header.is_importing_stage());
    let raw: Value = serde_json::from_str(
        &store
            .load_async_compaction_rows(&rig.reference)
            .unwrap()
            .unwrap()
            .state,
    )
    .unwrap();
    assert!(raw.get("initial").is_none());
    assert!(raw["standalone_move"].get("bound_drops").is_none());
    for (slot, expected) in [
        ("setup-initial", initial.clone()),
        ("moved-bound-drops", serde_json::to_value(&bound).unwrap()),
    ] {
        let json = store
            .load_async_compaction_baseline(&rig.reference, slot)
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&json).unwrap(), expected);
    }
    let _conn = guard_async_writes(dir.path().join("store.db"), "cold");
    state
        .ingest_read(store, codec::Codec::OpencodeAiSdk)
        .unwrap();
    state.save(store, &[]).unwrap();
    let reloaded = rig.state();
    assert_eq!(
        serde_json::to_vec(&reloaded.initial).unwrap(),
        serde_json::to_vec(&initial).unwrap()
    );
    assert_eq!(reloaded.standalone_move.unwrap().bound_drops, bound);
}

#[tokio::test]
async fn inline_payload_records_split_on_save_and_survive_reload() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = moved_session::moved_rig(dir.path(), true).await;
    rig.notice(1, 1_000, None).await;
    moved_session::settle_historian(&rig).await;
    let store = rig.h.store.get().unwrap();
    let state = rig.state();
    let initial = state.initial.clone();
    let bound = state.standalone_move.as_ref().unwrap().bound_drops.clone();
    let mut legacy = serde_json::to_value(&state).unwrap();
    legacy.as_object_mut().unwrap().remove("initial_stored");
    legacy.as_object_mut().unwrap().remove("initial_ready");
    legacy["initial"] = initial.clone();
    legacy["standalone_move"]
        .as_object_mut()
        .unwrap()
        .remove("bound_drops_stored");
    legacy["standalone_move"]["bound_drops"] = serde_json::to_value(&bound).unwrap();
    let key = state.key.store_key().conversation_key();
    let raw = legacy.to_string();
    let mut save = store.async_compaction_save(&rig.reference, &key, &state.key.session, &raw);
    save.baseline("setup-initial", None);
    save.baseline("moved-bound-drops", None);
    save.commit().unwrap();
    let mut loaded = rig.state();
    assert_eq!(loaded.initial, initial);
    assert_eq!(loaded.standalone_move.as_ref().unwrap().bound_drops, bound);
    loaded
        .remember_verified_ack_descent(store, "child", "L", 8)
        .unwrap();
    let reloaded = rig.state();
    assert_eq!(
        serde_json::to_vec(&reloaded.initial).unwrap(),
        serde_json::to_vec(&initial).unwrap()
    );
    assert_eq!(
        reloaded.standalone_move.as_ref().unwrap().bound_drops,
        bound
    );
    assert_eq!(reloaded.completed_seq, state.completed_seq);
    assert_eq!(reloaded.generation, state.generation);
}

#[tokio::test]
async fn changed_setup_payload_commits_with_its_header_or_not_at_all() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let store = rig.h.store.get().unwrap();
    let mut state = rig.state();
    let initial = state.initial.clone();
    let seq = state.seq;
    state.withdraw_pruning_permission().unwrap();
    let changed = state.initial.clone();
    assert_ne!(initial, changed);
    state.seq += 1;
    let conn = guard_async_writes(dir.path().join("store.db"), "initial");
    assert!(state.save(store, &[]).is_err());
    let mut reloaded = rig.state();
    assert_eq!(reloaded.initial, initial);
    assert_eq!(reloaded.seq, seq);
    conn.execute_batch("DROP TRIGGER fail_setup_payload")
        .unwrap();
    reloaded.withdraw_pruning_permission().unwrap();
    reloaded.seq += 1;
    reloaded.save(store, &[]).unwrap();
    let committed = rig.state();
    assert_eq!(
        serde_json::to_vec(&committed.initial).unwrap(),
        serde_json::to_vec(&changed).unwrap()
    );
    assert_eq!(committed.seq, seq + 1);
}
