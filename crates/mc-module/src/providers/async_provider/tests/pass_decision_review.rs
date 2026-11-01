use super::*;

/// Queued drops wait for a historian already in flight so its summary's rebuild
/// carries them. Rebuilding first for the drops would charge the session twice.
#[tokio::test]
async fn review_execute_pass_holds_drops_while_a_historian_run_is_in_flight() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    rig.history(10, "stable baseline history");
    rig.notice(2, 1_000, None).await;
    let baseline = rig.newest().unwrap();
    rig.queue(&[163, 166, 169]).await;
    let namespace = rig.state().namespace();
    let store = rig.h.store.get().unwrap();
    let mut loaded = store.load(&namespace).unwrap();
    loaded.meta.historian.state = mc_store::HistorianPhase::Firing;
    store
        .commit(&namespace, loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
    rig.notice(3, 75_000, Some(baseline)).await;
    assert_eq!(
        rig.newest(),
        Some(baseline),
        "a summary can come, so the execute pass must not rebuild for queued drops"
    );
    assert_eq!(store.load_pending_agent_drops(&namespace).unwrap().len(), 3);
}
