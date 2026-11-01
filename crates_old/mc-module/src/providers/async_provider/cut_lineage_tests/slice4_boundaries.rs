//! Host rewind shapes that must undo a cut whose head depends on removed rows.
use super::*;

fn replace_new_ids(pair: &Pair, through: u64, lineage: &str) {
    let mut previous = None;
    for entry in pair.transcript.entries.lock().unwrap().iter_mut() {
        if entry.ordinal > through {
            entry.mid = format!("{lineage}-m{}", entry.ordinal);
            match pair.profile {
                Profile::OpenCode => {
                    entry.message["info"]["id"] = json!(entry.mid);
                    for (index, part) in entry.message["parts"]
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .enumerate()
                    {
                        part["id"] = json!(format!("{}-p{index}", entry.mid));
                    }
                }
                Profile::Pi => {
                    entry.message["id"] = json!(entry.mid);
                    entry.message["parentId"] = json!(previous);
                }
                _ => {}
            }
        }
        previous = Some(entry.mid.clone());
    }
}

fn host_floor(
    pair: &mut Pair,
    through: u64,
    lineage: &str,
) -> Option<(u64, cut_runtime::PublishedCut)> {
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    pair.cut_checkpoints
        .retain(|first| first.saturating_sub(1) <= through);
    let selected = pair.cut_checkpoints.last().map(|first| {
        (
            *first,
            state
                .published_cut_for(
                    pair.resident.store(),
                    *first,
                    pair.cut_checkpoint_lineages
                        .get(first)
                        .expect("applied cut publishing lineage"),
                )
                .unwrap()
                .unwrap(),
        )
    });
    let head = selected
        .as_ref()
        .map(|(first, _)| cut_head(pair, lineage, *first));
    *pair.resident.runner.floor.lock().unwrap() = selected.as_ref().map(|(first, _)| *first);
    *pair.oracle.runner.floor.lock().unwrap() = None;
    *pair.resident.runner.head.lock().unwrap() = head;
    // The independent reference deliberately exposes the full transcript,
    // including on a reset, rather than adopting the runner's physical cut.
    *pair.oracle.runner.head.lock().unwrap() = None;
    selected
}

pub(super) async fn campaign_host_rewind(pair: &mut Pair, seed: u64, cut: u64) {
    if !matches!(pair.profile, Profile::OpenCode | Profile::Pi) {
        return;
    }
    let mut rng = Rng(seed ^ 0xB0A0_DA4E ^ cut);
    let first = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap()
        .lineage_first_ordinal;
    let period = if pair.profile == Profile::OpenCode {
        5
    } else {
        4
    };
    let end = (first + 12).div_ceil(period) * period;
    while newest_ordinal(pair) < end + 12 {
        pair.append(4);
    }
    review_complete_turn(pair);
    review_history(pair, end).await;
    pair.notice(&mut rng, None).await;
    let next = end + 1;
    let held = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    if held
        .published_cut_for(
            pair.resident.store(),
            next,
            held.lineage.as_deref().unwrap(),
        )
        .unwrap()
        .is_none()
    {
        review_ride(pair, "surface_change").await;
    }
    descend_pair(pair, next, &format!("host-marker-{seed}-{cut}")).await;
    let full = load(pair.oracle.store(), &pair.reference).unwrap().unwrap();
    let through = end - 1;
    pair.transcript
        .entries
        .lock()
        .unwrap()
        .truncate(through as usize + 1);
    let lineage = format!("host-rewind-{seed}-{cut}");
    *pair.transcript.lineage.lock().unwrap() = lineage.clone();
    pair.append_salted(4, seed ^ cut ^ 0xB011);
    replace_new_ids(pair, through, &lineage);
    let selected = host_floor(pair, through, &lineage);
    let descends = selected
        .as_ref()
        .map(|(first, saved)| json!({"lineage_id":saved.lineage,"through_ordinal":first-1}));
    let request = setup_request(
        pair,
        &lineage,
        descends,
        &format!("host-rewind-setup-{seed}-{cut}"),
    );
    let name = if pair.profile == Profile::OpenCode {
        "OpenCode user revert"
    } else {
        "Pi tree to assistant"
    };
    let answer = pair
        .both(name, |side| Box::pin(side.dispatch(request.clone())))
        .await;
    let decoded: Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(decoded["answer"], "ready", "{answer}");
    assert!(
        summaries_in(&answer).iter().all(|end| *end <= through),
        "{name} retained an abandoned summary: {answer}"
    );
    let first = if let Some((first, _)) = selected {
        restore_oracle_prefix(pair, full, first);
        first
    } else {
        0
    };
    pair.notice(&mut rng, None).await;
    pair.check_cut(first);
    if let Some((_, view, model, coverage)) = newest_view(pair) {
        assert!(
            summaries_in(&model).iter().all(|end| *end <= through),
            "{name} serves an abandoned summary"
        );
        assert!(
            missing_user_text(pair, &model, &view, coverage).is_empty(),
            "{name} lost replacement text"
        );
    }
    cut_runtime::measurements::host_rewind(pair.resident.store(), pair.profile == Profile::Pi);
}

async fn boundary_rewind(profile: Profile, fresh_ids: bool, setup: bool) {
    let end = if profile == Profile::Pi { 156 } else { 155 };
    let through = end - 1;
    let mut rng = Rng(0xB0155);
    let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
    pair.append(180);
    review_history(&mut pair, end).await;
    pair.notice(&mut rng, None).await;
    let staged = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let first = staged.newest_published_cut().unwrap().first_ordinal;
    descend_pair(&mut pair, first, "child").await;
    let parent = pair.transcript.lineage.lock().unwrap().clone();
    let digest = {
        let mut entries = pair.transcript.entries.lock().unwrap();
        entries.truncate(through as usize + 1);
        contract::digest::content_digest(&entries[through as usize].message)
    };
    let lineage = "host-rewind";
    *pair.transcript.lineage.lock().unwrap() = lineage.into();
    pair.append_salted(4, 5123);
    if fresh_ids {
        replace_new_ids(&pair, through, lineage);
    }
    let selected = host_floor(&mut pair, through, lineage);
    let before = newest_version(&pair);
    if setup {
        let descends = selected
            .as_ref()
            .map(|(first, cut)| json!({"lineage_id":cut.lineage,"through_ordinal":first-1}));
        let answer = pair
            .resident
            .dispatch(setup_request(&pair, lineage, descends, "boundary-rewind"))
            .await;
        let decoded: Value = serde_json::from_str(&answer).unwrap();
        assert_eq!(decoded["answer"], "ready", "{answer}");
        assert!(
            summaries_in(&answer).iter().all(|end| *end <= through),
            "Setup serves removed message: fork through {through}, initial {answer}"
        );
    } else {
        let outcome = resident_notice(
            &mut pair,
            &mut rng,
            Some(format!("{parent}:{through}:{digest}")),
        )
        .await;
        assert_eq!(outcome, "ok");
    }
    let outcome = publish_new_view(&mut pair, &mut rng, before).await;
    let (version, view, model, coverage) = newest_view(&pair).expect("rewind must publish");
    assert!(
        before.is_none_or(|old| version > old),
        "no new view: {outcome}"
    );
    assert!(
        summaries_in(&model).iter().all(|end| *end <= through),
        "fork through {through}: summary_ends={:?}",
        summaries_in(&model)
    );
    assert!(missing_user_text(&pair, &model, &view, coverage).is_empty());
    assert!(!load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap()
        .failed());
}

#[tokio::test]
async fn same_id_fork_at_the_seed_boundary_serves_no_removed_summary() {
    boundary_rewind(Profile::OpenCode, false, false).await;
}

#[tokio::test]
async fn fresh_id_setup_after_opencode_user_revert_serves_no_removed_summary() {
    boundary_rewind(Profile::OpenCode, true, true).await;
}

#[tokio::test]
async fn pi_tree_to_an_assistant_undoes_a_dependent_cut() {
    boundary_rewind(Profile::Pi, true, true).await;
}

#[tokio::test]
async fn historian_prelude_is_not_live_or_model_input() {
    let mut pair = Pair::open_with(Profile::Broca, false, Some("L"), false, false).await;
    review_enable(&pair);
    pair.append(120);
    let mut rng = Rng(0xB0199);
    review_history(&mut pair, 99).await;
    pair.notice(&mut rng, None).await;
    descend_pair(&mut pair, 100, "child").await;
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let prelude = state
        .cut_seed
        .as_ref()
        .unwrap()
        .historian_prelude
        .as_ref()
        .unwrap();
    assert_eq!(prelude.messages.last().unwrap().ordinal, 99);
    assert!(state.entries.keys().all(|ordinal| *ordinal >= 100));
    assert!(pair
        .resident
        .store()
        .load_async_compaction_entries_range(&pair.reference, 0, 99)
        .unwrap()
        .is_empty());
    assert!(historian_input(&pair.resident, &pair.reference).contains("answer 99.0"));
    cut_seed::pass_trace::take(pair.resident.store() as *const McStore as usize);
    pair.append(4);
    pair.notice(&mut rng, None).await;
    let trace = cut_seed::pass_trace::take(pair.resident.store() as *const McStore as usize);
    let actions = trace
        .iter()
        .filter(|line| line.starts_with("action="))
        .collect::<Vec<_>>();
    assert!(!actions.is_empty(), "{trace:?}");
    let inputs = trace
        .iter()
        .filter(|line| line.starts_with("engine_input "))
        .collect::<Vec<_>>();
    assert!(!inputs.is_empty(), "{trace:?}");
    for line in inputs {
        let ordinals: Vec<u64> =
            serde_json::from_str(line.split_once("ordinals=").unwrap().1).unwrap();
        assert!(
            !ordinals.contains(&99),
            "prelude row reached the engine: {line}"
        );
    }
    let (_, _, model, _) = newest_view(&pair).unwrap();
    assert!(!model.contains("answer 99.0"), "prelude leaked into a view");
    assert!(pair
        .resident
        .runner
        .reads_below_floor
        .lock()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn a_zero_source_frozen_head_requires_its_cut_to_survive() {
    let mut pair = Pair::open_with(Profile::Broca, false, Some("L"), false, false).await;
    pair.append(120);
    let mut rng = Rng(0xF20);
    review_history(&mut pair, 99).await;
    pair.notice(&mut rng, None).await;
    descend_pair(&mut pair, 100, "child").await;
    review_ride(&mut pair, "surface_change").await;
    let version = newest_version(&pair).unwrap();
    let store = pair.resident.store();
    let mut state = load(store, &pair.reference).unwrap().unwrap();
    state.applied = Some(version);
    state.capture_resync_sources(store).unwrap();
    let head = state
        .resync_sources
        .as_ref()
        .unwrap()
        .head
        .as_ref()
        .unwrap();
    assert!(
        head.messages.is_empty(),
        "the opaque prefix must not have held source rows"
    );
    assert!(head.required_cut.is_some());
    assert!(summaries_in(&head.bytes).contains(&99));
    state.cut_seed = None;
    state.cut_first_ordinal = None;
    state.lineage_first_ordinal = 0;
    let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap();
    state.restore_sources(store, codec).unwrap();
    assert!(
        state.restored_head.is_none(),
        "an empty row proof cannot preserve the undone cut's summary"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_revert_does_not_revalidate_an_opaque_cut_head() {
    review_session_inner(
        Profile::Broca,
        1_779_033_719,
        12,
        true,
        Some(vec![0, 1, 2, 3, 4, 5, 6, 9, 10, 11]),
        true,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resync_keeps_an_acknowledged_native_result_in_its_original_shape() {
    review_session_inner(Profile::Anthropic, 3_144_134_328, 12, false, None, true).await;
}

async fn unseen_fork_proof(extra: u64, fault: &str) {
    let mut pair = Pair::open_with(Profile::Broca, false, Some("L"), false, false).await;
    pair.append(120);
    let mut rng = Rng(0xF021);
    review_history(&mut pair, 99).await;
    pair.notice(&mut rng, None).await;
    descend_pair(&mut pair, 100, "child").await;
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let first = state.lineage_first_ordinal;
    let last = *state.entries.last_key_value().unwrap().0;
    let through = if fault == "below_cut" {
        first - 1
    } else {
        last + extra
    };
    if fault != "missing" {
        pair.append(extra);
    }
    review_complete_turn(&pair);
    let digest = {
        let mut entries = pair.transcript.entries.lock().unwrap();
        if fault == "overlap" {
            entries[(first + 1) as usize] = message(pair.profile, first + 1, 90_001);
        }
        entries
            .get(through as usize)
            .map(|entry| contract::digest::content_digest(&entry.message))
            .unwrap_or_else(|| "0".repeat(64))
    };
    let digest = if fault == "digest" || fault.starts_with("unretained") {
        "f".repeat(64)
    } else {
        digest
    };
    let header = format!("child:{through}:{digest}");
    *pair.transcript.lineage.lock().unwrap() = "unseen-fork".into();
    let proof = pair
        .resident
        .h
        .verify_unseen_descent(&state, "unseen-fork", &header, Duration::from_secs(30))
        .await
        .unwrap();
    assert!(pair
        .resident
        .runner
        .reads_below_floor
        .lock()
        .unwrap()
        .is_empty());
    if fault.is_empty() {
        assert_eq!(proof, Some(through));
    } else {
        assert_eq!(proof, None, "invalid {fault} proof must start fresh");
        let reported_first = if fault == "unretained_ordinal" {
            first + 4
        } else {
            first
        };
        let mut head = cut_head(&pair, "unseen-fork", reported_first);
        if fault == "unretained_digest" {
            head["cut"]["digest"] = json!("0".repeat(64));
        }
        *pair.resident.runner.head.lock().unwrap() = Some(head);
        let outcome = resident_notice(&mut pair, &mut rng, Some(header)).await;
        if fault.starts_with("unretained") {
            assert!(outcome.contains("cut_rebootstrap_required"), "{outcome}");
            assert!(!outcome.contains("unknown_cut"), "{outcome}");
            assert!(pair
                .resident
                .runner
                .reads_below_floor
                .lock()
                .unwrap()
                .is_empty());
            return;
        }
        assert_eq!(
            outcome, "ok",
            "invalid descent must recover from the retained physical cut"
        );
        assert!(pair
            .resident
            .runner
            .reads_below_floor
            .lock()
            .unwrap()
            .is_empty());
        let reset = load(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        assert_ne!(reset.generation, state.generation);
        assert!(reset.cut_seed.is_some());
        assert_eq!(reset.cut_first_ordinal, Some(first));
        assert_eq!(reset.lineage_first_ordinal, first);
        assert!(!reset.failed());
        let before = state.cut_seed.as_ref().unwrap();
        let after = reset.cut_seed.as_ref().unwrap();
        assert_eq!(
            (after.max_tag, after.real_users, after.covered_user_turns),
            (before.max_tag, before.real_users, before.covered_user_turns)
        );
    }
}

#[tokio::test]
async fn unseen_fork_two_rows_after_held_proves_the_whole_window() {
    unseen_fork_proof(2, "").await;
}

#[tokio::test]
async fn unseen_fork_three_rows_after_held_never_reads_below_the_cut() {
    unseen_fork_proof(3, "").await;
}

#[tokio::test]
async fn unseen_fork_with_a_wrong_through_digest_starts_fresh() {
    unseen_fork_proof(2, "digest").await;
}

#[tokio::test]
async fn unseen_fork_with_a_changed_interior_overlap_row_starts_fresh() {
    unseen_fork_proof(3, "overlap").await;
}

#[tokio::test]
async fn unseen_fork_below_the_cut_starts_fresh() {
    unseen_fork_proof(2, "below_cut").await;
}

#[tokio::test]
async fn unseen_fork_with_a_missing_through_row_starts_fresh() {
    unseen_fork_proof(2, "missing").await;
}

#[tokio::test]
async fn unretained_head_cut_digest_requests_rebootstrap_without_reading() {
    unseen_fork_proof(2, "unretained_digest").await;
}

#[tokio::test]
async fn unretained_head_cut_ordinal_requests_rebootstrap_without_reading() {
    unseen_fork_proof(2, "unretained_ordinal").await;
}

#[tokio::test]
async fn legacy_seed_crossing_its_wire_cut_is_refused_then_restarts_fresh() {
    let mut pair = Pair::open_with(Profile::OpenCode, false, Some("L"), false, false).await;
    pair.append(180);
    let mut rng = Rng(0xB1E6);
    review_history(&mut pair, 155).await;
    pair.notice(&mut rng, None).await;
    let first = 156;
    descend_pair(&mut pair, first, "child").await;
    let store = pair.resident.store();
    let mut state = load(store, &pair.reference).unwrap().unwrap();
    let mut legacy = state.cut_seed.as_ref().unwrap().as_ref().clone();
    legacy.first_ordinal = 154;
    let key = state.cached_cut(first).unwrap().key();
    let mut cut = state.published_cuts.remove(&key).unwrap();
    cut.covered_through = None;
    cut.first_ordinal = 154;
    cut.seed_suffix = Some("154".into());
    state.pending_cut_metadata.insert(cut.key(), cut.clone());
    state.published_cuts.insert(cut.key(), cut);
    state.setup.descends_from = Some(compact::lineage::DescendsFrom::new("L", 153));
    state.cut_first_ordinal = Some(154);
    state.cut_seed = Some(Arc::new(legacy.clone()));
    state.journal.cut_seed_dirty = true;
    state.pending_cut_seeds.insert("154".into(), legacy);
    state.save(store, &[]).unwrap();
    review_restart(&pair);
    let answer = pair
        .resident
        .dispatch(setup_request(
            &pair,
            "child",
            Some(json!({"lineage_id":"L","through_ordinal":153})),
            "legacy-cut",
        ))
        .await;
    let decoded: Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(decoded["answer"], "refuse", "{answer}");
    assert_eq!(decoded["code"], "unsafe_cut_seed", "{answer}");
    assert!(summaries_in(&answer).is_empty());
    *pair.transcript.lineage.lock().unwrap() = "fresh".into();
    *pair.resident.runner.floor.lock().unwrap() = None;
    *pair.resident.runner.head.lock().unwrap() = None;
    let answer = pair
        .resident
        .dispatch(setup_request(&pair, "fresh", None, "fresh-after-legacy"))
        .await;
    let decoded: Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(decoded["answer"], "ready", "{answer}");
    let state = load(store, &pair.reference).unwrap().unwrap();
    assert!(state.cut_seed.is_none());
    assert!(state.cut_first_ordinal.is_none());
    assert_eq!(resident_notice(&mut pair, &mut rng, None).await, "ok");
}

#[tokio::test]
async fn oversized_prelude_defers_only_the_cut_until_a_normal_restart() {
    let mut pair = Pair::open_with(Profile::OpenCode, false, Some("L"), false, false).await;
    pair.append(120);
    let mut rng = Rng(0xB0D6);
    review_history(&mut pair, 99).await;
    pair.notice(&mut rng, None).await;
    let store = Arc::clone(pair.resident.h.store.get().unwrap());
    cut_runtime::measurements::take(&store);
    let mut state = pair
        .resident
        .h
        .checkout(&store, &pair.reference)
        .unwrap()
        .unwrap();
    let old_cut = state.cached_cut(100).unwrap().version;
    let original = Arc::clone(&state.entries[&99]);
    let mut large = original.read().unwrap();
    // This opaque field stays embedded in the native message JSON rather than
    // becoming an external content reference, so its bytes count against the
    // historian prelude's retained byte budget.
    large.message["info"]["opaque_metadata"] =
        json!("x".repeat(cut_seed::MAX_HISTORIAN_PRELUDE_BYTES + 1));
    state
        .entries
        .insert(99, Arc::new(HeldEntry::from_read(&large).unwrap()));
    store.arm_soft_refresh(&state.namespace()).unwrap();
    let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap();
    let view = pair
        .resident
        .h
        .publish_async(0, &mut state, codec, true)
        .unwrap()
        .expect("view still publishes");
    assert!(view.cut.is_none());
    assert_eq!(state.cached_cut(100).unwrap().version, old_cut);
    state.save(&store, &[]).unwrap();
    assert!(store
        .load_async_compaction_view(&pair.reference, view.view_version)
        .unwrap()
        .is_some());
    state.entries.insert(99, original);
    pair.resident.h.checkin(state);

    // Summarizing through assistant message 103 makes 103 the newest restart
    // (InputIndex indexes assistant ordinals). The new prelude starts there,
    // excluding the large message 99, so the next cut can advance.
    pair.append(4);
    publish_history(&pair.resident, &pair.reference, 103);
    assert_eq!(
        resident_notice_at(&mut pair, 30_000, Some(view.view_version)).await,
        "ok"
    );
    let state = load(&store, &pair.reference).unwrap().unwrap();
    assert!(state.cached_cut(104).is_some());
    let stats = cut_runtime::measurements::take(&store);
    assert!(stats.deferred_cuts >= 1, "{stats:?}");
    assert!(stats.largest_deferred_bytes > cut_seed::MAX_HISTORIAN_PRELUDE_BYTES);
    assert!(stats.max_prelude_bytes <= cut_seed::MAX_HISTORIAN_PRELUDE_BYTES);
}

#[tokio::test]
async fn a_matching_version_cannot_announce_summary_dependencies_beyond_the_cut() {
    let mut pair = Pair::open_with(Profile::OpenCode, false, Some("L"), false, false).await;
    pair.append(120);
    let mut rng = Rng(0xB05);
    review_history(&mut pair, 99).await;
    pair.notice(&mut rng, None).await;
    let store = pair.resident.store();
    let mut state = load(store, &pair.reference).unwrap().unwrap();
    let key = state.cached_cut(100).unwrap().key();
    let mut kept = state.published_cuts.remove(&key).unwrap();
    let raw = store
        .load_async_compaction_view(&pair.reference, kept.version)
        .unwrap()
        .unwrap();
    let mut view: view::CompactionView = serde_json::from_str(&raw).unwrap();
    let version = store
        .reserve_async_compaction_version(&pair.reference, kept.version)
        .unwrap();
    view.view_version = version;
    view.cut.as_mut().unwrap().through_ordinal = 98;
    view.digest = view.compute_digest();
    kept.version = version;
    kept.covered_through = Some(99);
    kept.first_ordinal = 99;
    state.published_cuts.insert(kept.key(), kept);
    state.save(store, &[]).unwrap();
    store
        .save_async_compaction_view(
            &pair.reference,
            version,
            &serde_json::to_string(&view).unwrap(),
            "{}",
        )
        .unwrap();
    pair.resident.h.announce_async_views().await.unwrap();
    assert!(store
        .pending_async_compaction_views()
        .unwrap()
        .iter()
        .any(|(_, seen, _)| *seen == version));
}
