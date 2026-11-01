//! Two real Setup descents per seeded session, against a full-input engine oracle.
use super::*;

fn compare_decisions(pair: &Pair, after: u64, seed: u64) -> usize {
    let resident = cut_seed::notice_trace::take(pair.resident.store() as *const McStore as usize);
    let oracle = cut_seed::notice_trace::take(pair.oracle.store() as *const McStore as usize);
    assert_eq!(
        resident, oracle,
        "{:?} seed {seed}: independent skip/run decisions; steps={:?}",
        pair.profile, pair.log
    );
    for sequence in after + 1..=pair.seq {
        assert!(
            oracle.iter().any(|(seen, _)| *seen == sequence),
            "{:?} seed {seed}: notice {sequence} has no decision trace",
            pair.profile
        );
    }
    oracle.len()
}

fn verify_passes(pair: &Pair, seed: u64) -> usize {
    let resident = cut_seed::pass_trace::take(pair.resident.store() as *const McStore as usize);
    let oracle = cut_seed::pass_trace::take(pair.oracle.store() as *const McStore as usize);
    let actions = |lines: &[String]| {
        lines
            .iter()
            .filter(|line| line.starts_with("action="))
            .count()
    };
    let attempts = |lines: &[String]| {
        lines
            .iter()
            .filter(|line| line.starts_with("engine_input "))
            .count()
    };
    assert_eq!(attempts(&resident), attempts(&oracle), "{:?} seed {seed}: both providers must attempt the same engine passes; resident={resident:?} full={oracle:?}", pair.profile);
    assert_eq!(actions(&resident), actions(&oracle), "{:?} seed {seed}: both providers must run the same engine passes; resident={resident:?} full={oracle:?}", pair.profile);
    assert_eq!(
        oracle
            .iter()
            .filter(|line| line.starts_with("full_input "))
            .count(),
        attempts(&oracle),
        "{:?} seed {seed}: each full-input pass needs an exact source-identity proof: resident={resident:?} full={oracle:?}; steps={:?}",
        pair.profile, pair.log
    );
    attempts(&oracle)
}

async fn descend_pair(pair: &mut Pair, first: u64, child: &str) {
    for side in [&pair.resident, &pair.oracle] {
        assert_published_cut_support(side, &pair.reference);
    }
    let full = load(pair.oracle.store(), &pair.reference).unwrap().unwrap();
    let mut request = serde_json::to_value(&full.setup).unwrap();
    request["lineage_id"] = json!(child);
    request["descends_from"] = json!({"lineage_id":full.lineage,"through_ordinal":first - 1});
    request["request_id"] = json!(format!("setup-{child}"));
    let label = format!("production cut Setup at {first}");
    let answer = pair
        .both(&label, |side| {
            let request = request.clone();
            Box::pin(async move {
                side.dispatch(json!({"method":"compaction.setup","params":request}))
                    .await
            })
        })
        .await;
    let answer: Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(answer["answer"], "ready", "{answer}");
    *pair.transcript.lineage.lock().unwrap() = child.into();
    *pair.resident.runner.floor.lock().unwrap() = Some(first);
    if !pair.cut_checkpoints.contains(&first) {
        pair.cut_checkpoints.push(first);
    }
    pair.cut_checkpoint_lineages
        .insert(first, full.lineage.clone().unwrap());

    restore_oracle_prefix(pair, full, first);
}

fn restore_oracle_prefix(pair: &Pair, full: State, first: u64) {
    let codec = codec::Codec::from_params(&Value::Object(full.setup.params.clone())).unwrap();
    // Setup has the same public semantics on both sides. Only the oracle gets
    // original prefix rows instead of cut facts for its full-input engine.
    let store = pair.oracle.store();
    let mut oracle = pair
        .oracle
        .h
        .checkout(store, &pair.reference)
        .unwrap()
        .unwrap();
    // Restore only the immutable prefix on the full-input reference. Each
    // side independently adopted its parent's observed window cache, or its
    // own immutable snapshot when revisiting an earlier cut.
    for (ordinal, entry) in full.entries.range(..first) {
        oracle.entries.insert(*ordinal, Arc::clone(entry));
    }
    oracle.cut_seed = None;
    oracle.cut_first_ordinal = None;
    oracle.logical_prefix = None;
    oracle.prefix_input_proof = None;
    oracle.aggregates = Default::default();
    oracle.entry_bytes = (None, 0);
    oracle.mid_index.clear();
    oracle.tag_index.clear();
    oracle.journal.persisted_through = None;
    oracle.journal.indexed_through = None;
    oracle.journal.truncate = Some(None);
    let rows = tag_rows(&oracle, codec).unwrap();
    oracle.save(store, &rows).unwrap();
    pair.oracle.h.checkin(oracle);
    let held = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    assert_eq!(held.lineage_first_ordinal, first);
    assert_eq!(held.cut_seed.as_ref().unwrap().first_ordinal, first);
    assert!(held.entries.keys().all(|ordinal| *ordinal >= first));
    assert!(load(pair.oracle.store(), &pair.reference)
        .unwrap()
        .unwrap()
        .entries
        .contains_key(&0));
}

async fn session(profile: Profile, number: u64, steps: u64) -> (usize, usize) {
    let mut rng = Rng(number.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
    pair.oracle
        .h
        .provider_store
        .async_runtime
        .full_input_only
        .store(true, std::sync::atomic::Ordering::Relaxed);
    for side in [&pair.resident, &pair.oracle] {
        side.h
            .provider_store
            .async_runtime
            .record_notice_decisions
            .store(true, std::sync::atomic::Ordering::Relaxed);
        cut_seed::pass_trace::take(side.store() as *const McStore as usize);
        cut_seed::notice_trace::take(side.store() as *const McStore as usize);
    }
    attest(&pair.resident);
    attest(&pair.oracle);
    pair.append(208 + rng.below(5) * 4);
    let mut previous = 0;
    let (mut decisions, mut passes) = (0, 0);
    for cut in 0..2 {
        if cut > 0 {
            pair.append(32);
        }
        if profile != Profile::OpenCode {
            while pair
                .transcript
                .entries
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .ordinal
                % 4
                != 3
            {
                pair.append(1);
            }
        }
        let last = pair
            .transcript
            .entries
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .ordinal;
        let mut history_end = (last - 24) / 4 * 4 + 3;
        let reference = pair.reference.clone();
        pair.both("history for next production cut", |side| {
            let reference = reference.clone();
            Box::pin(async move { publish_history(side, &reference, history_end) })
        })
        .await;
        let sequence = pair.seq;
        pair.notice(&mut rng, None).await;
        {
            let historian = |side: &Side| {
                let head = load_head(side.store(), &pair.reference).unwrap().unwrap();
                serde_json::to_value(
                    side.store()
                        .load_meta(&head.namespace())
                        .unwrap()
                        .meta
                        .historian,
                )
                .unwrap()
            };
            let (full, cut) = (historian(&pair.oracle), historian(&pair.resident));
            assert_eq!(without_rows_below(full.clone(), 0), without_rows_below(cut.clone(), 0), "{profile:?} seed {number}: historian non-clock state diverged before descent: full={full} cut={cut}");
        }
        decisions += compare_decisions(&pair, sequence, number);
        passes += verify_passes(&pair, number);
        let mut first = None;
        for attempt in 0..12 {
            let held = load(pair.resident.store(), &pair.reference)
                .unwrap()
                .unwrap();
            first = held
                .published_cuts
                .values()
                .filter(|cut| {
                    cut.first_ordinal > previous
                        && held.lineage.as_deref() == Some(cut.lineage.as_str())
                })
                .map(|cut| cut.first_ordinal)
                .max();
            if first.is_some() {
                break;
            }
            // A signed/in-flight turn may defer a fold. Complete another turn
            // and offer the ordinary rewrite opportunity; never fabricate a seed.
            pair.append(if profile == Profile::OpenCode { 1 } else { 4 });
            let request = json!({"method":"compaction.ride","params":{"session_ref":pair.reference,"cause":"surface_change","deadline_ms":10_000}});
            pair.both(&format!("cut preparation ride {attempt}"), |side| {
                Box::pin(side.dispatch(request.clone()))
            })
            .await;
            passes += verify_passes(&pair, number);
        }
        let first = first.unwrap_or_else(|| panic!("{profile:?} seed {number}: no advancing adoptable cut after completing turns; previous={previous}; steps={:?}", pair.log));
        assert!(
            first > previous,
            "each session must descend at two advancing cuts"
        );
        descend_pair(&mut pair, first, &format!("child-{cut}")).await;
        for _ in 0..steps {
            for side in [&pair.resident, &pair.oracle] {
                cut_seed::pass_trace::take(side.store() as *const McStore as usize);
                cut_seed::notice_trace::take(side.store() as *const McStore as usize);
            }
            let sequence = pair.seq;
            pair.cut_step(&mut rng, first, &mut history_end).await;
            decisions += compare_decisions(&pair, sequence, number);
            passes += verify_passes(&pair, number);
            pair.check_cut(first);
        }
        previous = first;
    }
    assert!(pair
        .resident
        .runner
        .reads_below_floor
        .lock()
        .unwrap()
        .is_empty());
    assert!(
        pair.engine_mismatches.borrow().is_empty(),
        "{profile:?} seed {number}: {:?}; steps={:?}",
        pair.engine_mismatches.borrow(),
        pair.log
    );
    (decisions, passes)
}

async fn differential(sessions: u64, steps: u64) {
    let first_seed = std::env::var("MC_PRODUCTION_CUT_FIRST_SEED")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(70_000);
    let mut tasks = Vec::new();
    let mut failures = Vec::new();
    let (mut decisions, mut passes) = (0, 0);
    for index in 0..sessions {
        tasks.push((
            first_seed + index,
            tokio::spawn(session(
                PROFILES[((first_seed + index) % 4) as usize],
                first_seed + index,
                steps,
            )),
        ));
        if tasks.len() == 4 || index + 1 == sessions {
            for (seed, task) in std::mem::take(&mut tasks) {
                match task.await {
                    Ok((seen, verified)) => {
                        decisions += seen;
                        passes += verified;
                    }
                    Err(error) => failures.push(format!("seed {seed}: {error}")),
                }
            }
            if !failures.is_empty() {
                break;
            }
        }
    }
    assert!(
        failures.is_empty(),
        "two-cut failures after all session tasks settled: {failures:?}"
    );
    eprintln!("production differential: {sessions} sessions x 2 advancing cuts x {steps} steps over 4 formats; {decisions} independent notice decisions matched; {passes} full-input passes proved every source identity; strict engine-state comparison; 0 divergences");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn successive_production_cuts_match_full_processing() {
    differential(4, 6).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "long two-cut production differential; run explicitly"]
async fn successive_production_cuts_match_full_processing_over_many_sessions() {
    let sessions = std::env::var("MC_PRODUCTION_CUT_SESSIONS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);
    let steps = std::env::var("MC_PRODUCTION_CUT_STEPS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(24);
    differential(sessions, steps).await;
}

/// Additional adversarial cut-lineage tests use the same fixtures.
#[path = "slice4_review.rs"]
mod slice4_review;
