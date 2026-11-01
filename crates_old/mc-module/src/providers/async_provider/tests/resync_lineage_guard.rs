//! A source reread does not qualify an engine baseline from another lineage.
use super::*;
use crate::providers::async_provider::resync_replay::Replay;

#[tokio::test]
async fn mismatched_engine_lineage_is_not_captured_or_restored() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    let store = rig.h.store.get().unwrap();
    let mut state = rig.state();
    let valid = Replay::capture(&state).unwrap().expect("matching baseline");
    let original_engine = state.engine_with_baselines().unwrap();
    let mut wrong_produced = original_engine.clone();
    wrong_produced
        .last_produced
        .as_mut()
        .unwrap()
        .range
        .lineage_id = "other-lineage".into();
    state.adopt_engine(wrong_produced).unwrap();
    assert!(
        Replay::capture(&state).unwrap().is_none(),
        "a produced baseline from another lineage must not authorize replay"
    );
    state.adopt_engine(original_engine).unwrap();
    state.lineage = Some("next-lineage".into());
    assert!(
        Replay::capture(&state).unwrap().is_none(),
        "an applied baseline from another lineage must not authorize replay"
    );
    assert!(
        !valid.matches(&state).unwrap(),
        "a persisted replay must not restore another lineage's engine"
    );
    state.reset_for_notice(store).unwrap();
    assert!(state.resync_sources.as_ref().unwrap().replay.is_none());
    rig.h.checkin(state);
    *rig.runner.lineage.lock().unwrap() = "next-lineage".into();
    rig.notice(2, 1_000, None).await;
    let recovered = rig.state();
    assert_eq!(recovered.completed_seq, 2);
    assert!(!recovered.resync && !recovered.engine_failed && !recovered.failed());
    let engine = recovered.engine_with_baselines().unwrap();
    assert_eq!(
        engine.last_applied.unwrap().range.lineage_id,
        "next-lineage"
    );
}
