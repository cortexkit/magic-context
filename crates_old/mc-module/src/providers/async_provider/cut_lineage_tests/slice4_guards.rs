//! Direct boundary checks for the cut protocol's rejection and replay guards.
use super::*;

async fn uncut() -> (Pair, u64) {
    let mut pair = Pair::open_with(Profile::Broca, false, Some("L"), false, false).await;
    pair.append(120);
    review_history(&mut pair, 99).await;
    pair.notice(&mut Rng(721), None).await;
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let first = state.newest_published_cut().unwrap().first_ordinal;
    (pair, first)
}

fn held(pair: &Pair) -> State {
    load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap()
}

fn codec_of(state: &State) -> codec::Codec {
    codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap()
}

#[tokio::test]
async fn m01_cut_requires_its_publishing_lineage() {
    let (pair, first) = uncut().await;
    let state = held(&pair);
    let cut = state.cached_cut(first).unwrap();
    let store = pair.resident.store();
    let seed = store
        .load_async_compaction_baseline(&pair.reference, &format!("published-cut:{}", cut.key()))
        .unwrap()
        .unwrap();
    let wrong_key = cut_runtime::cut_key(first, "not-L");
    // A stale cache alias must not make another lineage's payload a valid
    // descendant, even when its lookup key names the requested parent.
    let record = serde_json::to_string(&state).unwrap();
    let key = state.key.store_key().conversation_key();
    let mut save = store.async_compaction_save(&pair.reference, &key, &state.key.session, &record);
    save.baseline(format!("published-cut:{wrong_key}"), Some(seed));
    save.baseline(
        format!("published-cut-meta:{wrong_key}"),
        Some(serde_json::to_string(cut).unwrap()),
    );
    save.commit().unwrap();
    let answer = pair
        .resident
        .dispatch(setup_request(
            &pair,
            "child",
            Some(json!({
                "lineage_id":"not-L", "through_ordinal":first-1
            })),
            "wrong-parent",
        ))
        .await;
    assert!(answer.contains("unknown_cut"), "{answer}");
    assert_eq!(held(&pair).lineage.as_deref(), Some("L"));
}

#[tokio::test]
async fn m02_rendered_source_below_cut_is_not_staged() {
    let (pair, first) = uncut().await;
    let store = pair.resident.store();
    let mut state = held(&pair);
    let codec = codec_of(&state);
    let version = state.cached_cut(first).unwrap().version;
    let view: view::CompactionView = serde_json::from_str(
        &store
            .load_async_compaction_view(&pair.reference, version)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    let mut engine = state.engine_with_baselines().unwrap();
    engine.last_produced.as_mut().unwrap().replacement.push(
        decoded_entry(codec, &state.entries[&0].inbound().unwrap())
            .unwrap()
            .ck,
    );
    state.adopt_engine(engine).unwrap();
    state.published_cuts.clear();
    state
        .keep_published_cut(store, codec, first, &view)
        .unwrap();
    assert!(state.published_cuts.is_empty());
}

#[tokio::test]
async fn m03_child_history_wins_over_late_parent_history() {
    let (mut pair, first) = uncut().await;
    descend_pair(&mut pair, first, "child").await;
    let store = pair.resident.store();
    let mut state = held(&pair);
    let parent = serde_json::to_value(state.pending_parent_history.as_ref().unwrap()).unwrap()
        ["namespace"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut history = store.load_compartments(&state.namespace()).unwrap();
    history[0].end_message += 4;
    store.replace_compartments(&parent, &history).unwrap();
    history[0].end_message += 4;
    store
        .replace_compartments(&state.namespace(), &history)
        .unwrap();
    state.forward_parent_history(store).unwrap();
    assert_eq!(
        store.load_compartments(&state.namespace()).unwrap()[0].end_message,
        history[0].end_message
    );
}

#[tokio::test]
async fn m04_pending_parent_history_prevents_skip() {
    let (pair, _rng, _first) = cut_pair(Profile::OpenCode, 723).await;
    let mut state = held(&pair);
    let mut notice =
        notice::AdvanceNotice::from_headers(state.conditions.as_ref().unwrap()).unwrap();
    notice.est_tokens = 1000;
    state.fold_entries(codec_of(&state), None).unwrap();
    let store = pair.resident.store();
    let loaded = store.load_meta(&state.namespace()).unwrap();
    let mut meta = loaded.meta;
    meta.reasoning_clear_initialized = true;
    meta.emergency_drain_active = false;
    if let Some(policy) = &mut state.usage_policy {
        policy.emergency_recovery_armed = false;
    }
    store
        .commit_meta(&state.namespace(), loaded.row_version, &meta)
        .unwrap();
    assert!(
        pair.resident
            .h
            .async_engine_can_skip(&state, &notice)
            .unwrap(),
        "{}",
        resident::counters::last_engine_reason()
    );
    state.pending_parent_history = Some(
        serde_json::from_value(json!({"namespace":state.namespace(),"revision":null})).unwrap(),
    );
    assert!(!pair
        .resident
        .h
        .async_engine_can_skip(&state, &notice)
        .unwrap());
}

#[tokio::test]
async fn m05_unkept_cut_is_not_announced() {
    let (pair, _) = uncut().await;
    let store = pair.resident.store();
    let mut state = held(&pair);
    let version = state.newest_published_cut().unwrap().version;
    let raw = store
        .load_async_compaction_view(&pair.reference, version)
        .unwrap()
        .unwrap();
    let view: view::CompactionView = serde_json::from_str(&raw).unwrap();
    let version = store
        .reserve_async_compaction_version(&pair.reference, version)
        .unwrap();
    let mut unkept = view.clone();
    unkept.view_version = version;
    state.published_cuts.clear();
    state.save(store, &[]).unwrap();
    store
        .save_async_compaction_view(
            &pair.reference,
            version,
            &serde_json::to_string(&unkept).unwrap(),
            "{}",
        )
        .unwrap();
    pair.resident.h.announce_async_views().await.unwrap();
    assert!(store
        .pending_async_compaction_views()
        .unwrap()
        .iter()
        .any(|(_, v, _)| *v == version));
}

#[tokio::test]
async fn m06_explicit_read_from_zero_is_fenced_at_cut() {
    let (pair, _rng, first) = cut_pair(Profile::Broca, 724).await;
    let mut state = held(&pair);
    pair.resident
        .h
        .read_async_resumable(&mut state, 0, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(
        pair.resident
            .runner
            .reads_below_floor
            .lock()
            .unwrap()
            .is_empty(),
        "read below {first}"
    );
}

#[tokio::test]
async fn m07_publication_does_not_recut_the_lineage_origin() {
    let (pair, first) = uncut().await;
    let store = pair.resident.store();
    let mut state = held(&pair);
    state.lineage_first_ordinal = first;
    store.arm_soft_refresh(&state.namespace()).unwrap();
    pair.resident
        .h
        .publish_async(0, &mut state, codec_of(&held(&pair)), true)
        .unwrap();
    let raw = store
        .load_async_compaction_view(
            &pair.reference,
            store
                .load_async_compaction_views(&pair.reference)
                .unwrap()
                .1,
        )
        .unwrap()
        .unwrap();
    let view: view::CompactionView = serde_json::from_str(&raw).unwrap();
    assert!(view.cut.is_none(), "{view:?}");
}

#[tokio::test]
async fn m08_notice_origin_must_match_session_head() {
    let pair = Pair::open_with(Profile::Broca, false, Some("L"), false, false).await;
    let mut state = held(&pair);
    state.conditions = Some(BTreeMap::from([("first_ordinal".into(), "1".into())]));
    assert!(pair
        .resident
        .h
        .ensure_lineage_window(&mut state, Duration::from_secs(10))
        .await
        .is_err());
}

#[tokio::test]
async fn m09_catchup_does_not_report_summarized_tags_as_unknown() {
    let (pair, _rng, _first) = cut_pair(Profile::Broca, 725).await;
    let state = held(&pair);
    let number = state.cut_seed.as_ref().unwrap().pre_cut_tags[0].0;
    let answer = pair
        .resident
        .dispatch(json!({"name":"ctx_reduce","arguments":{"drop":format!("{number},999999")}}))
        .await;
    assert!(
        answer.contains("already in the history summary"),
        "{answer}"
    );
    assert!(
        !answer.contains(&format!("not found: {number}")),
        "{answer}"
    );
    assert!(!answer.contains(&format!("{number}, 999999")), "{answer}");
}

#[tokio::test]
async fn m10_descent_applies_the_selected_cut_version() {
    let (pair, first) = uncut().await;
    let store = pair.resident.store();
    let state = held(&pair);
    let slot = format!("published-cut:{}", state.cached_cut(first).unwrap().key());
    let mut seed: cut_seed::CutSeed = serde_json::from_str(
        &store
            .load_async_compaction_baseline(&pair.reference, &slot)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    seed.window
        .record
        .as_mut()
        .unwrap()
        .insert("applied".into(), Value::Null);
    let record = serde_json::to_string(&state).unwrap();
    let key = state.key.store_key().conversation_key();
    let mut save = store.async_compaction_save(&pair.reference, &key, &state.key.session, &record);
    save.baseline(slot, Some(serde_json::to_string(&seed).unwrap()));
    save.commit().unwrap();
    let answer = pair
        .resident
        .dispatch(setup_request(
            &pair,
            "child",
            Some(json!({"lineage_id":"L","through_ordinal":first-1})),
            "apply",
        ))
        .await;
    assert!(answer.contains("ready"), "{answer}");
    assert_eq!(
        held(&pair).applied,
        Some(state.cached_cut(first).unwrap().version)
    );
}

#[tokio::test]
async fn m11_cut_registry_outlives_view_retention() {
    let (pair, first) = uncut().await;
    let mut state = held(&pair);
    state.applied = Some(state.engine.version_high_water + 100);
    state.produced_view = None;
    state.applied_view = None;
    state.engine_baselines = Default::default();
    state.save(pair.resident.store(), &[]).unwrap();
    let mut reloaded = load_head(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    // The bounded in-record cache may evict a cut; view retirement must not
    // delete its durable descriptor or prevent a later lazy lookup.
    reloaded.published_cuts.clear();
    assert!(reloaded
        .published_cut(pair.resident.store(), first)
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn m12_publication_places_cut_after_the_complete_head() {
    let (pair, first) = uncut().await;
    let mut state = held(&pair);
    let entry = state.entries[&first].read().unwrap();
    // An acknowledged empty first-window message must stay outside the
    // immutable head. The cut follows the entire summary, not an earlier
    // historian restart that would leave a summarized row on the live side.
    state
        .frozen_edits
        .insert_drop(&entry.mid, "0", &served_part_digest(&entry, "0").unwrap());
    pair.resident
        .store()
        .arm_soft_refresh(&state.namespace())
        .unwrap();
    let codec = codec_of(&state);
    let view = pair
        .resident
        .h
        .publish_async(0, &mut state, codec, true)
        .unwrap()
        .unwrap();
    assert_eq!(
        view.cut.as_ref().map(|cut| cut.through_ordinal + 1),
        Some(first)
    );
    assert_published_cut_support(&pair.resident, &pair.reference);
    assert!(view.ranges.iter().any(|range| range.to() == first));
    assert!(view.ranges.iter().any(|range| range.from() == first));
}

#[tokio::test]
async fn m13_repeated_descent_returns_the_original_head() {
    let (pair, _rng, _first) = cut_pair(Profile::Broca, 726).await;
    let state = held(&pair);
    let request = serde_json::to_value(&state.setup).unwrap();
    let answer = pair
        .resident
        .dispatch(json!({"method":"compaction.setup","params":request}))
        .await;
    let answer: Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(answer["answer"], "ready");
    assert_eq!(answer["initial"], state.initial["initial"]);
}

#[tokio::test]
async fn m14_capture_requires_a_historian_restart() {
    let (pair, first) = uncut().await;
    let mut state = held(&pair);
    let codec = codec_of(&state);
    state.fold_entries(codec, None).unwrap();
    let count = state.aggregates.historian_input.count();
    // A persisted floor alone does not prove that the prelude begins at a
    // historian restart; the indexed source must certify that position.
    state.aggregates.historian_input = historian_tail::InputIndex::seeded(first - 4, count);
    assert_eq!(
        state
            .capture_cut_seed(pair.resident.store(), codec, first)
            .unwrap()
            .unwrap_err(),
        cut_seed::CaptureRefusal::NotAtRestartPoint
    );
}

#[tokio::test]
async fn m15_capture_rejects_a_split_tool_arc() {
    let (pair, _) = uncut().await;
    let mut state = held(&pair);
    let codec = codec_of(&state);
    assert_eq!(
        state
            .capture_cut_seed(pair.resident.store(), codec, 2)
            .unwrap()
            .unwrap_err(),
        cut_seed::CaptureRefusal::SplitsToolArc
    );
}

#[tokio::test]
async fn m16_capture_requires_contiguous_history_coverage() {
    let (pair, first) = uncut().await;
    let mut state = held(&pair);
    let store = pair.resident.store();
    let codec = codec_of(&state);
    let mut history = store.load_compartments(&state.namespace()).unwrap();
    history[0].start_message = 4;
    store
        .replace_compartments(&state.namespace(), &history)
        .unwrap();
    assert_eq!(
        state
            .capture_cut_seed(store, codec, first)
            .unwrap()
            .unwrap_err(),
        cut_seed::CaptureRefusal::NotCovered
    );
}
