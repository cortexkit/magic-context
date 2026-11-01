//! Regression tests for cut-lineage descent, held-window edits and reset behavior.
use super::*;

#[path = "slice4_final_review.rs"]
mod slice4_final_review;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r03_unseen_descent_is_attempted_on_the_notice_path() {
    review_session_inner(Profile::Pi, 3_144_134_339, 12, false, None, true).await;
}

/// A cut lineage whose runner forks it at an endpoint ck-mc has not read
/// yet, after rewriting a held window row, so neither descent proof holds.
/// The runner keeps the physical cut: its `session.head` for the new
/// lineage reports the same first ordinal and cut message, and it refuses
/// reads below the cut. Checks the notice outcomes, the reads below the cut,
/// the failure state and whether a newer view was served: returns an empty
/// string when all hold, otherwise a diagnostic naming what went wrong.
async fn unverifiable_fork_in_a_cut_lineage(profile: Profile) -> String {
    let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
    pair.append(120);
    let mut rng = Rng(0x5E5E_0001);
    review_history(&mut pair, 99).await;
    pair.notice(&mut rng, None).await;
    descend_pair(&mut pair, 100, "child").await;
    pair.append(8);
    review_complete_turn(&pair);
    let mut trail = vec![resident_notice(&mut pair, &mut rng, None).await];
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let first = state.lineage_first_ordinal;
    let last = *state.entries.last_key_value().unwrap().0;
    // The runner edited a held row inside the window, then forked two rows
    // past what ck-mc has read.
    pair.append(2);
    let through = last + 2;
    let digest = {
        let mut entries = pair.transcript.entries.lock().unwrap();
        entries[(first + 1) as usize] = message(profile, first + 1, 90_123);
        contract::digest::content_digest(&entries[through as usize].message)
    };
    *pair.transcript.lineage.lock().unwrap() = "edited-fork".into();
    pair.append_salted(2, 6_007);
    review_complete_turn(&pair);
    *pair.resident.runner.head.lock().unwrap() = Some(cut_head(&pair, "edited-fork", first));
    let before = newest_version(&pair);
    trail.push(
        resident_notice(
            &mut pair,
            &mut rng,
            Some(format!("child:{through}:{digest}")),
        )
        .await,
    );
    for _ in 0..3 {
        pair.append(4);
        review_complete_turn(&pair);
        let applied = newest_version(&pair);
        trail.push(resident_notice_at(&mut pair, 30_000, applied).await);
    }
    let newest = newest_version(&pair);
    trail.push(publish_new_view(&mut pair, &mut rng, newest).await);
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let reads = pair
        .resident
        .runner
        .reads_below_floor
        .lock()
        .unwrap()
        .clone();
    let served = newest_view(&pair)
        .filter(|(version, ..)| before.is_none_or(|before| *version > before))
        .map(|(version, view, model, coverage)| {
            (
                version,
                summaries_in(&model),
                missing_user_text(&pair, &model, &view, coverage),
            )
        });
    let healthy = trail
        .iter()
        .all(|outcome| !outcome.contains("Err") && !outcome.contains("error"))
        && reads.is_empty()
        && !state.failed()
        && served
            .as_ref()
            .is_some_and(|(_, _, missing)| missing.is_empty());
    if healthy {
        String::new()
    } else {
        format!(
            "{profile:?}: cut at {first}, held through {last}, fork through {through}: notices {trail:?}; reads below the cut {reads:?}; failed {}; cut_first_ordinal {:?}, lineage_first_ordinal {}; new view (version, summaries, missing user text) {served:?}; namespace compartments end at {:?}",
            state.failed(),
            state.cut_first_ordinal,
            state.lineage_first_ordinal,
            compartment_ends(&pair.resident, &pair.reference),
        )
    }
}

/// R-01. An unverifiable fork inside a cut lineage resets the record and
/// drops the cut floor. The runner still begins the forked lineage at the
/// cut, so the reset must rebuild from the cut with the history that covers
/// the rows below it, and keep publishing, without reading below the cut.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r01_unverifiable_fork_in_a_cut_lineage_keeps_publishing_from_the_cut() {
    let mut problems = Vec::new();
    for profile in PROFILES {
        let problem = unverifiable_fork_in_a_cut_lineage(profile).await;
        if !problem.is_empty() {
            problems.push(problem);
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Sizes after each of `rounds` historian publications that advance the cut
/// without the runner descending: (registered cuts, record JSON bytes,
/// staged namespaces that still have a head, bytes of the record and ordinary
/// baseline rows that every load fetches).
async fn registry_growth(profile: Profile, rounds: u64) -> Vec<(usize, usize, usize, usize)> {
    let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
    pair.append(120);
    let mut rng = Rng(0x5E5E_0002);
    let mut sizes = Vec::new();
    let mut oldest_cut = None;
    for _ in 0..rounds {
        pair.append(8);
        review_complete_turn(&pair);
        let newest = newest_ordinal(&pair);
        review_history(&mut pair, (newest - 12) / 4 * 4 + 3).await;
        pair.notice(&mut rng, None).await;
        let state = load(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        if oldest_cut.is_none() {
            oldest_cut = state
                .newest_published_cut()
                .map(|cut| (cut.first_ordinal, cut.lineage.clone()));
        }
        let staged = state
            .published_cuts
            .values()
            .filter(|cut| {
                pair.resident
                    .store()
                    .load_namespace_head(&format!(
                        "{}:async:{}",
                        state.key.engine_key(),
                        cut.generation
                    ))
                    .unwrap()
                    .is_some()
            })
            .count();
        for cut in state.published_cuts.values() {
            let namespace = format!("{}:async:{}", state.key.engine_key(), cut.generation);
            assert!(
                pair.resident
                    .store()
                    .load_compartments(&namespace)
                    .unwrap()
                    .is_empty(),
                "stages must reference immutable history, not copy its compartment payloads"
            );
        }
        let ordinary = pair
            .resident
            .store()
            .load_async_compaction_rows(&pair.reference)
            .unwrap()
            .unwrap();
        // Baseline-only bytes can be zero before the first acknowledged edit.
        // Count the real record too so the loaded-byte ratio has a denominator
        // while still measuring bytes the ordinary loader actually fetched.
        let loaded = ordinary.state.len()
            + ordinary
                .baselines
                .iter()
                .map(|(slot, json)| slot.len() + json.len())
                .sum::<usize>();
        assert!(
            ordinary.baselines.iter().all(|(slot, _)| {
                !slot.starts_with("published-cut:")
                    && !slot.starts_with("published-cut-meta:")
                    && !slot.starts_with("published-cut-candidate:")
                    && !slot.starts_with("published-cut-root:")
                    && !slot.starts_with("cut-history:")
                    && !slot.starts_with("cut:")
            }),
            "ordinary loads must not hydrate retained cut archives"
        );
        for first in state.published_cuts.keys() {
            let raw = pair
                .resident
                .store()
                .load_async_compaction_baseline(&pair.reference, &format!("published-cut:{first}"))
                .unwrap()
                .unwrap();
            let seed: Value = serde_json::from_str(&raw).unwrap();
            assert!(seed["recovery_history_ref"].is_object());
            assert!(
                seed.get("recovery_history").is_none(),
                "history payloads must be shared by identity"
            );
        }
        sizes.push((
            state.published_cuts.len(),
            serde_json::to_string(&state).unwrap().len(),
            staged,
            loaded,
        ));
    }
    let (first, parent) = oldest_cut.unwrap();
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    assert!(
        state.cached_cut(first).is_none(),
        "fixture must reach beyond the in-record cache"
    );
    let answer = pair
        .resident
        .dispatch(setup_request(
            &pair,
            "oldest-cut-revert",
            Some(json!({"lineage_id":parent,"through_ordinal":first-1})),
            "r02-oldest",
        ))
        .await;
    assert_eq!(
        serde_json::from_str::<Value>(&answer).unwrap()["answer"],
        "ready",
        "{answer}"
    );
    assert!(summaries_in(&answer).iter().all(|end| *end < first));
    let restored = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    assert_eq!(restored.cut_first_ordinal, Some(first));
    assert_eq!(
        pair.resident
            .store()
            .max_compartment_end_ordinal(&restored.namespace())
            .unwrap(),
        (first - 1) as i64
    );
    sizes
}

/// R-02. The cut registry is never pruned: every publication that advances
/// the cut adds an entry holding that cut's rendered head, kept in the
/// record saved whenever a notice completes normal processing, plus a
/// staged namespace and a seed row that every load of the record reads.
/// The record must stay bounded by the window, not grow with the number
/// of cuts a long session has published.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r02_cut_registry_stays_bounded_over_many_advancing_cuts() {
    let sizes = registry_growth(Profile::Broca, 24).await;
    let (early_cuts, early_bytes, _, early_loaded) = sizes[5];
    let (late_cuts, late_bytes, late_staged, late_loaded) = *sizes.last().unwrap();
    eprintln!(
        "R-02 growth (cuts, record bytes, staged namespaces, loaded baseline bytes) per round: {sizes:?}"
    );
    assert!(
        late_cuts <= early_cuts.max(4)
            && late_bytes <= early_bytes * 2
            && late_loaded <= early_loaded * 2,
        "after 6 publications: {early_cuts} cuts, record {early_bytes} bytes, loaded baselines {early_loaded} bytes; after {}: {late_cuts} cuts, record {late_bytes} bytes, {late_staged} staged namespaces, loaded baselines {late_loaded} bytes; per round {sizes:?}",
        sizes.len()
    );
    assert!(
        sizes.iter().all(|(cuts, _, staged, loaded)| *cuts <= 4
            && *staged <= 4
            && *loaded <= early_loaded * 2),
        "every one of the 24 ordinary loads must stay flat after warmup: {sizes:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r03_generation_numbering_checks_cut_and_retired_stage_high_water() {
    let mut pair = Pair::open_with(Profile::Broca, false, Some("L"), false, false).await;
    pair.append(120);
    review_history(&mut pair, 99).await;
    pair.notice(&mut Rng(0x601), None).await;
    let mut state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let generation = state.generation;
    state.published_cuts.values_mut().next().unwrap().generation = generation + 50;
    state.retired_cut_stages.push(format!(
        "{}:async:{}",
        state.key.engine_key(),
        generation + 100
    ));
    assert_eq!(state.next_generation().unwrap(), generation + 101);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r03_capture_rejects_history_placed_after_its_wire_cut() {
    let mut pair = Pair::open_with(Profile::Broca, false, Some("L"), false, false).await;
    pair.append(120);
    review_history(&mut pair, 99).await;
    pair.notice(&mut Rng(0x602), None).await;
    let mut state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap();
    state.fold_entries(codec, None).unwrap();
    assert_eq!(
        state
            .capture_cut_seed(pair.resident.store(), codec, 99)
            .unwrap()
            .unwrap_err(),
        cut_seed::CaptureRefusal::SummaryBeyondCut
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r04_cut_history_shares_individual_compartments_and_bounds_each_seed() {
    let mut pair = Pair::open_with(Profile::Broca, false, Some("L"), false, false).await;
    pair.append(120);
    review_history(&mut pair, 99).await;
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let template = pair
        .resident
        .store()
        .load_compartments(&state.namespace())
        .unwrap()
        .remove(0);
    let mut history = Vec::new();
    let mut first_seed_bytes = None;
    let mut leaf_bytes = 0;
    pair.resident
        .store()
        .arm_async_write_meter(&state.reference());
    for index in 0..64 {
        let mut compartment = template.clone();
        compartment.sequence = index + 1;
        compartment.start_message = index;
        compartment.end_message = index;
        compartment.start_message_id = format!("m{index}");
        compartment.end_message_id = format!("m{index}");
        compartment.content = "immutable history payload ".repeat(1024);
        history.push(compartment);
        let mut seed = cut_seed::CutSeed::without_rows(
            (index + 1) as u64,
            format!("m{index}"),
            index + 1,
            format!("m{index}"),
        );
        seed.set_recovery_history(history.clone(), None, Some(index as u64))
            .unwrap();
        let raw = serde_json::to_string(&seed).unwrap();
        let first = *first_seed_bytes.get_or_insert(raw.len());
        assert!(
            raw.len() <= first * 2,
            "each seed must contain a fixed-size root, not its history payloads"
        );
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert!(value.get("recovery_history").is_none());
        assert!(value["recovery_history_ref"].is_object());
        if index == 0 {
            leaf_bytes = seed.pending_history_objects.values().next().unwrap().len();
        }
        let reference = state.reference();
        let key = state.key.store_key().conversation_key();
        let record = serde_json::to_string(&state).unwrap();
        let mut save = pair.resident.store().async_compaction_save(
            &reference,
            &key,
            &state.key.session,
            &record,
        );
        for (slot, raw) in &seed.pending_history_objects {
            save.immutable_baseline(slot, raw.clone());
        }
        save.baseline(format!("published-cut:{}", index + 1), Some(raw));
        save.baseline(
            format!("published-cut-root:{}", index + 1),
            Some(serde_json::to_string(&seed.history_root()).unwrap()),
        );
        save.commit().unwrap();
        seed.pending_history_objects.clear();
        let recovered = seed
            .recovery_compartments(pair.resident.store(), &reference)
            .unwrap();
        assert_eq!(
            serde_json::to_value(recovered).unwrap(),
            serde_json::to_value(&history).unwrap()
        );
    }
    let bytes = pair
        .resident
        .store()
        .async_write_stats(&state.reference())
        .unwrap()
        .bytes as usize;
    assert!(
        bytes <= 64 * leaf_bytes * 3,
        "shared payloads must be stored once, not copied into all 64 cuts: {bytes}"
    );
    let mut state = state;
    state.gc_cut_history(pair.resident.store()).unwrap();
    let (_, before) = pair
        .resident
        .store()
        .async_cut_history_index(&pair.reference)
        .unwrap();
    let pinned = pair
        .resident
        .store()
        .load_async_compaction_baseline(&pair.reference, "published-cut:63")
        .unwrap()
        .unwrap();
    state.cut_seed = Some(Arc::new(serde_json::from_str(&pinned).unwrap()));
    let reference = state.reference();
    let key = state.key.store_key().conversation_key();
    let record = serde_json::to_string(&state).unwrap();
    let mut save =
        pair.resident
            .store()
            .async_compaction_save(&reference, &key, &state.key.session, &record);
    for cut in 1..64 {
        save.baseline(format!("published-cut-root:{cut}"), None);
        save.baseline(format!("published-cut:{cut}"), None);
    }
    save.commit().unwrap();
    state.gc_cut_history(pair.resident.store()).unwrap();
    let (_, after) = pair
        .resident
        .store()
        .async_cut_history_index(&pair.reference)
        .unwrap();
    assert!(
        after.len() < before.len(),
        "superseded roots must release unshared archive objects"
    );
    assert_eq!(
        state
            .cut_seed
            .as_ref()
            .unwrap()
            .recovery_compartments(pair.resident.store(), &reference)
            .unwrap()
            .len(),
        63
    );
    state.cut_seed = None;
    state.gc_cut_history(pair.resident.store()).unwrap();
    let (_, unpinned) = pair
        .resident
        .store()
        .async_cut_history_index(&pair.reference)
        .unwrap();
    assert!(
        unpinned.len() < after.len(),
        "an inactive superseded root must not pin archive objects forever"
    );
    let raw = pair
        .resident
        .store()
        .load_async_compaction_baseline(&reference, "published-cut:64")
        .unwrap()
        .unwrap();
    let retained: cut_seed::CutSeed = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        serde_json::to_value(
            retained
                .recovery_compartments(pair.resident.store(), &reference)
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&history).unwrap()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r02_deep_revert_matches_full_processing_after_its_stage_is_retired() {
    for profile in PROFILES {
        let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
        pair.append(120);
        let mut rng = Rng(0xD33F);
        let mut cuts = Vec::new();
        for _ in 0..10 {
            pair.append(8);
            review_complete_turn(&pair);
            let newest = newest_ordinal(&pair);
            review_history(&mut pair, (newest - 12) / 4 * 4 + 3).await;
            pair.notice(&mut rng, None).await;
            let state = load(pair.resident.store(), &pair.reference)
                .unwrap()
                .unwrap();
            let cut = state.newest_published_cut().unwrap();
            cuts.push((cut.first_ordinal, cut.clone()));
        }
        let (first, cut) = &cuts[1];
        let through = first + 3;
        assert!(through < cuts[2].0 - 1);
        let before = load(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        assert!(before.cached_cut(*first).is_none());
        assert!(pair
            .resident
            .store()
            .load_namespace_head(&format!(
                "{}:async:{}",
                before.key.engine_key(),
                cut.generation
            ))
            .unwrap()
            .is_none());
        pair.transcript
            .entries
            .lock()
            .unwrap()
            .truncate(through as usize + 1);
        descend_pair(&mut pair, *first, "deep-revert").await;
        let cold = load(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        let active = cold.cut_seed.as_ref().unwrap();
        assert!(
            active.window.entries.is_empty() && active.window.head.is_none(),
            "ordinary reload must read compact cut facts, not the archived window seed"
        );
        for _ in 0..3 {
            pair.append_salted(4, 90_100 + pair.seq);
            review_complete_turn(&pair);
            pair.notice(&mut rng, None).await;
        }
        let (_, view, model, coverage) = newest_view(&pair).unwrap();
        assert!(
            summaries_in(&model).contains(&(first - 1)),
            "{profile:?}: {model}"
        );
        assert!(
            summaries_in(&model).iter().all(|end| *end <= through),
            "{profile:?}: a reverted summary was served"
        );
        assert!(missing_user_text(&pair, &model, &view, coverage).is_empty());
        assert!(pair
            .resident
            .runner
            .reads_below_floor
            .lock()
            .unwrap()
            .is_empty());
    }
}

async fn branch_summary(pair: &mut Pair, marker: &str, end: u64) {
    review_history(pair, end).await;
    for side in [&pair.resident, &pair.oracle] {
        let state = load_head(side.store(), &pair.reference).unwrap().unwrap();
        let mut rows = side.store().load_compartments(&state.namespace()).unwrap();
        rows[0].content = format!("{marker}: summary through {end}");
        rows[0].p1 = Some(rows[0].content.clone());
        side.store()
            .replace_compartments(&state.namespace(), &rows)
            .unwrap();
    }
}

async fn same_ordinal_branches(
    profile: Profile,
    branches: usize,
    preserve_anchor: bool,
) -> (Pair, State, Vec<ReadMessage>, u64) {
    let mut pair = Pair::open_with(profile, false, Some("lineage-A"), false, false).await;
    *pair.transcript.lineage.lock().unwrap() = "lineage-A".into();
    pair.append(120);
    let mut rng = Rng(0x0ABA_B100);
    branch_summary(&mut pair, "branch-A-only-summary", 99).await;
    pair.notice(&mut rng, None).await;
    let saved_a = pair.transcript.entries.lock().unwrap().clone();
    let full_a = load(pair.oracle.store(), &pair.reference).unwrap().unwrap();
    let first = load_head(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap()
        .newest_published_cut()
        .unwrap()
        .first_ordinal;
    assert_eq!(first, 100);
    descend_pair(&mut pair, first, "A-cut").await;
    for branch in 1..branches {
        *pair.transcript.entries.lock().unwrap() = saved_a[..20].to_vec();
        pair.append_salted(100, 80_000 + branch as u64);
        if preserve_anchor {
            pair.transcript.entries.lock().unwrap()[first as usize - 1] =
                saved_a[first as usize - 1].clone();
        }
        let lineage = format!("lineage-{}", (b'A' + branch as u8) as char);
        *pair.transcript.lineage.lock().unwrap() = lineage.clone();
        *pair.resident.runner.floor.lock().unwrap() = None;
        *pair.resident.runner.head.lock().unwrap() = None;
        *pair.oracle.runner.floor.lock().unwrap() = None;
        *pair.oracle.runner.head.lock().unwrap() = None;
        pair.cut_checkpoints.clear();
        pair.cut_checkpoint_lineages.clear();
        let request = setup_request(&pair, &lineage, None, &format!("setup-{lineage}"));
        let answer = pair
            .both("new branch below every cut", |side| {
                Box::pin(side.dispatch(request.clone()))
            })
            .await;
        assert_eq!(
            serde_json::from_str::<Value>(&answer).unwrap()["answer"],
            "ready"
        );
        pair.notice(&mut rng, None).await;
        branch_summary(
            &mut pair,
            &format!("branch-{}-only-summary", (b'A' + branch as u8) as char),
            first - 1,
        )
        .await;
        pair.notice(&mut rng, None).await;
        let state = load_head(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        assert_eq!(state.newest_published_cut().unwrap().first_ordinal, first);
        assert_eq!(state.newest_published_cut().unwrap().lineage, lineage);
    }
    (pair, full_a, saved_a, first)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r02_same_ordinal_branches_restore_their_own_exact_cut_after_eviction() {
    for profile in PROFILES {
        let (mut pair, full_a, saved_a, first) = same_ordinal_branches(profile, 6, false).await;
        let state = load_head(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        assert_eq!(
            state.published_cuts.len(),
            4,
            "lineage variants must count toward the cache bound"
        );
        assert!(!state
            .published_cuts
            .contains_key(&cut_runtime::cut_key(first, "lineage-A")));
        assert_eq!(
            pair.resident
                .store()
                .load_async_cut_candidates(&pair.reference, first)
                .unwrap()
                .len(),
            6
        );
        let ancestor = state
            .published_cut_for(pair.resident.store(), first, "lineage-A")
            .unwrap()
            .unwrap();
        assert!(pair
            .resident
            .store()
            .load_namespace_head(&format!(
                "{}:async:{}",
                state.key.engine_key(),
                ancestor.generation
            ))
            .unwrap()
            .is_none());
        *pair.transcript.entries.lock().unwrap() = saved_a[..first as usize + 8].to_vec();
        let request = setup_request(
            &pair,
            "A-return",
            Some(json!({"lineage_id":"lineage-A","through_ordinal":first-1})),
            "switch-to-A",
        );
        let answer = pair
            .both("switch to older branch A cut", |side| {
                Box::pin(side.dispatch(request.clone()))
            })
            .await;
        assert_eq!(
            serde_json::from_str::<Value>(&answer).unwrap()["answer"],
            "ready",
            "{answer}"
        );
        assert!(
            answer.contains("branch-A-only-summary"),
            "{profile:?}: {answer}"
        );
        assert!(
            !answer.contains("branch-B-only-summary"),
            "{profile:?}: {answer}"
        );
        *pair.transcript.lineage.lock().unwrap() = "A-return".into();
        *pair.resident.runner.floor.lock().unwrap() = Some(first);
        *pair.resident.runner.head.lock().unwrap() = Some(cut_head(&pair, "A-return", first));
        pair.cut_checkpoints.push(first);
        pair.cut_checkpoint_lineages
            .insert(first, "lineage-A".into());
        restore_oracle_prefix(&pair, full_a, first);
        let mut rng = Rng(0x0ABA_B101);
        for index in 0..3 {
            pair.append_salted(4, 91_000 + index);
            review_complete_turn(&pair);
            pair.notice(&mut rng, None).await;
        }
        let (_, view, model, coverage) = newest_view(&pair).unwrap();
        assert!(
            model.contains("branch-A-only-summary"),
            "{profile:?}: {model}"
        );
        assert!(
            !model.contains("branch-B-only-summary"),
            "{profile:?}: {model}"
        );
        assert!(summaries_in(&model).iter().all(|end| *end < first));
        assert!(missing_user_text(&pair, &model, &view, coverage).is_empty());
        assert!(pair
            .resident
            .runner
            .reads_below_floor
            .lock()
            .unwrap()
            .is_empty());
    }
}

async fn same_ordinal_head_refusal(profile: Profile, ambiguous: bool) {
    let (mut pair, _, _, first) = same_ordinal_branches(profile, 2, ambiguous).await;
    descend_pair(&mut pair, first, "B-cut").await;
    *pair.transcript.lineage.lock().unwrap() = "unverifiable-head".into();
    let mut head = cut_head(&pair, "unverifiable-head", first);
    if !ambiguous {
        head["cut"]["digest"] = json!("0".repeat(64));
    }
    *pair.resident.runner.head.lock().unwrap() = Some(head);
    let before = newest_version(&pair);
    let mut rng = Rng(0x0ABA_B102);
    for _ in 0..2 {
        let outcome = resident_notice(&mut pair, &mut rng, None).await;
        assert!(
            outcome.contains("cut_rebootstrap_required"),
            "{profile:?}: {outcome}"
        );
        assert!(!outcome.contains("unknown_cut"), "{profile:?}: {outcome}");
        let state = load(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        assert!(!state.failed());
        assert!(
            state.cut_seed.is_none() && state.produced_view.is_none(),
            "an unresolvable head must not adopt another branch's summary"
        );
        assert!(newest_version(&pair)
            .is_none_or(|version| before.is_some_and(|before| version <= before)));
        assert!(pair
            .resident
            .runner
            .reads_below_floor
            .lock()
            .unwrap()
            .is_empty());
        pair.append(4);
        review_complete_turn(&pair);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r01_no_same_ordinal_candidate_matches_the_head_refuses_by_name() {
    for profile in PROFILES {
        same_ordinal_head_refusal(profile, false).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r01_ambiguous_same_ordinal_head_refuses_instead_of_choosing_a_branch() {
    for profile in PROFILES {
        same_ordinal_head_refusal(profile, true).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn r05_restore_keeps_the_certified_prefix_without_a_cold_repair_backup() {
    let mut pair = Pair::open_with(Profile::Broca, false, Some("L"), false, false).await;
    pair.append(120);
    let mut rng = Rng(0xA505);
    review_history(&mut pair, 99).await;
    pair.notice(&mut rng, None).await;
    descend_pair(&mut pair, 100, "restore-only").await;
    let store = pair.resident.store();
    let mut state = load(store, &pair.reference).unwrap().unwrap();
    let source_namespace = state.namespace();
    let original_history = store.load_compartments(&source_namespace).unwrap();
    assert_eq!(original_history.len(), 1);
    assert_eq!(
        (
            original_history[0].start_message,
            original_history[0].end_message
        ),
        (0, 99)
    );
    assert_eq!(state.entries.first_key_value().unwrap().0, &100);
    state.reset(store).unwrap();
    let sources = state.resync_sources.as_ref().unwrap();
    assert_eq!(sources.history.len(), 1);
    assert!(
        sources.history[0].messages.is_empty(),
        "rows below the physical cut are not held"
    );
    // Discarding archived recovery objects must not erase the stored source
    // compartments. Restore fills the prefix without those discarded objects.
    let (roots, objects) = store.async_cut_history_index(&pair.reference).unwrap();
    assert!(!objects.is_empty());
    assert!(store
        .discard_async_cut_history_objects(&pair.reference, &objects, &roots)
        .unwrap());
    assert!(state
        .cut_seed
        .as_ref()
        .unwrap()
        .pending_history_objects
        .is_empty());
    assert!(
        state
            .cut_seed
            .as_ref()
            .unwrap()
            .recovery_compartments(store, &pair.reference)
            .is_err(),
        "the repair backup must really be unavailable"
    );
    let progress = Box::pin(pair.resident.h.read_async_resumable(
        &mut state,
        0,
        Duration::from_secs(30),
    ))
    .await
    .unwrap();
    assert!(matches!(progress, ReadProgress::Complete));
    assert_eq!(state.entries.first_key_value().unwrap().0, &100);
    state.reindex().unwrap();
    let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap();
    state.restore_sources(store, codec).unwrap();
    let restored = store.load_compartments(&state.namespace()).unwrap();
    assert_eq!(
        serde_json::to_value(restored).unwrap(),
        serde_json::to_value(&original_history).unwrap()
    );
    assert_eq!(
        serde_json::to_value(store.load_compartments(&source_namespace).unwrap()).unwrap(),
        serde_json::to_value(original_history).unwrap()
    );
    assert_eq!(
        store
            .load_meta(&state.namespace())
            .unwrap()
            .meta
            .coverage_ordinal,
        Some(99)
    );
    assert!(state.resync_sources.is_none());
    assert!(state
        .cut_seed
        .as_ref()
        .unwrap()
        .recovery_compartments(store, &pair.reference)
        .is_err());
    assert!(state.entries.keys().all(|ordinal| *ordinal >= 100));
    assert!(pair
        .resident
        .runner
        .reads_below_floor
        .lock()
        .unwrap()
        .is_empty());
}
