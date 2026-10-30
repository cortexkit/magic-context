use super::*;

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
