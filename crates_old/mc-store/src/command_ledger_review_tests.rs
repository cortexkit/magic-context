fn cut_binding() -> crate::move_store::CutBinding {
    crate::move_store::CutBinding {
        cut_id: "review-cut".into(),
        session_ref: "0123456789abcdef".into(),
        host_session_id: "a".into(),
        host_end_offset: 1,
        host_cut: json!({"lastMessageId":"message-a"}),
        mc_start_offset: 1,
    }
}

#[test]
fn review_ops_admission_preserves_move_capture_schema_compatibility() {
    let (clean, clean_dir) = fixture();
    let mut mover = clean.move_store().unwrap();
    mover.acquire_fence(&cut_binding()).unwrap();
    mover.freeze("review-cut").unwrap();
    mover
        .capture("review-cut", &clean_dir.path().join("clean-capture"))
        .unwrap();

    let (store, dir) = fixture();
    store.ops_flush("other-session", "one", true, 1).unwrap();
    let mut mover = store.move_store().unwrap();
    mover.acquire_fence(&cut_binding()).unwrap();
    mover.freeze("review-cut").unwrap();
    let result = mover.capture("review-cut", &dir.path().join("capture"));
    assert!(
        result.is_ok(),
        "a UI command in another session must not break move capture: {result:?}"
    );
}

#[test]
fn review_ops_discard_primitive_retires_ledger_without_delete_session() {
    let (store, _dir) = fixture();
    store.ops_flush("a", "one", true, 1).unwrap();
    let other = store.ops_flush("b", "one", true, 1).unwrap();
    // Model a persisted destination cut directly: current move capture rejects
    // the new ledger tables, so this tests discard cleanup, not a full transfer.
    store.inner.with_conn_fenced(|tx| {
        tx.execute("INSERT INTO mc_move_cuts(cut_id,session_id,binding,manifest_digest,state) VALUES('review-cut','a','{}','','staged')", [])?;
        tx.execute("INSERT INTO mc_move_fences(session_id,cut_id,phase) VALUES('a','review-cut','staged')", [])?;
        tx.execute("INSERT INTO mc_move_installs(cut_id,session_id,manifest_digest) VALUES('review-cut','a','')", [])?;
        Ok(())
    }).unwrap();
    let mut mover = store.move_store().unwrap();
    mover.begin_discard("review-cut").unwrap();
    let mut done = false;
    for _ in 0..512 {
        if mover.discard_batch("review-cut").unwrap() {
            done = true;
            break;
        }
    }
    assert!(
        done,
        "discard did not finish within the synthetic row bound"
    );
    assert!(store.load_meta("a").unwrap().row_version.is_none());
    assert!(
        store.ops_job("a", Some("one"), None).unwrap().is_none(),
        "discard removed the cache parent but retained its command ledger"
    );
    assert!(store.ops_events("a", 0, 64).unwrap()["events"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(store.ops_job("b", Some("one"), None).unwrap(), Some(other));
}
