//! Tests that need the module after the large-session compose speed-ups (they call
//! `CoveredOrdinals`, `surviving_strip_units_reference` and
//! `compose_m0_with_score_snapshot`): edge cases of the merged coverage ranges and of
//! the strip-unit survival parser beyond their randomized references, the
//! one-compartment-read fold against a publication landing between two reads, and an
//! ignored measurement of store lock waits under concurrent sessions.

use super::compose_large_session::LargeSession;
use super::tests::{item, req, store};
use super::*;

/// Every list of up to three spans with endpoints in -1..=5 (inverted, empty,
/// zero-length, adjacent, nested, duplicated and negative spans, in every order)
/// agrees with the per-compartment scan on ordinals 0..=7.
#[test]
fn covered_ordinals_agree_with_the_scan_on_every_small_span_list() {
    let endpoints = -1i64..=5;
    let spans: Vec<(i64, i64)> = endpoints
        .clone()
        .flat_map(|start| endpoints.clone().map(move |end| (start, end)))
        .collect();
    let row = |(start, end): (i64, i64)| StoredCompartment {
        start_message: start,
        end_message: end,
        ..Default::default()
    };
    let mut lists: Vec<Vec<StoredCompartment>> = vec![Vec::new()];
    for &a in &spans {
        lists.push(vec![row(a)]);
        for &b in &spans {
            lists.push(vec![row(a), row(b)]);
            for &c in &spans {
                lists.push(vec![row(a), row(b), row(c)]);
            }
        }
    }
    for compartments in &lists {
        let covered = CoveredOrdinals::new(compartments);
        for ordinal in 0..=7u64 {
            assert_eq!(
                covered.contains(ordinal),
                compartments
                    .iter()
                    .any(|compartment| stored_compartment_covers_ordinal(compartment, ordinal)),
                "ordinal {ordinal}: {:?}",
                compartments
                    .iter()
                    .map(|c| (c.start_message, c.end_message))
                    .collect::<Vec<_>>()
            );
        }
    }
}

/// Spans at the integer limits: a span ending at `i64::MAX` merges with an adjacent
/// one without overflow, and ordinals above `i64::MAX` are never covered.
#[test]
fn covered_ordinals_handle_the_integer_limits() {
    let rows = [(i64::MIN, -1), (5, i64::MAX), (i64::MAX, i64::MAX), (1, 4)].map(|(start, end)| {
        StoredCompartment {
            start_message: start,
            end_message: end,
            ..Default::default()
        }
    });
    let covered = CoveredOrdinals::new(&rows);
    for ordinal in [0, 1, 4, 5, i64::MAX as u64, i64::MAX as u64 + 1, u64::MAX] {
        assert_eq!(
            covered.contains(ordinal),
            rows.iter()
                .any(|row| stored_compartment_covers_ordinal(row, ordinal)),
            "ordinal {ordinal}"
        );
    }
}

/// Strip targets built from message ids with several `#`, empty ids, non-ASCII digits,
/// signs, padding, whitespace and indices past `usize` agree with the formatted-id
/// reference for every combination of live message ids and block counts below.
#[test]
fn strip_survival_matches_the_reference_on_hostile_ids() {
    let mids = [
        "", "#", "##", "a#", "#0", "m", "m#1", "m#01", "m#1#2", "x٣", "m#٣", "m 1",
    ];
    let suffixes = [
        "",
        "#",
        "#0",
        "#1",
        "#2",
        "#3",
        "#00",
        "#01",
        "#+1",
        "#-0",
        "# 1",
        "#1 ",
        "#٣",
        "#0#0",
        "#1#",
        "#18446744073709551615",
        "#18446744073709551616",
        "#99999999999999999999999",
    ];
    let mut targets = Vec::new();
    for mid in mids {
        for suffix in suffixes {
            targets.push(format!("{mid}{suffix}"));
        }
    }
    let mut core = CoreState::default();
    for (index, target) in targets.iter().enumerate() {
        // General kinds take the live-target check; the reasoning kinds are durable
        // regardless and are included to keep the prefix filters in the comparison.
        let kind = ["drop", "image", "tool_result", "reasoning_age"][index % 4];
        core.frozen_units.push(FrozenUnit {
            key: format!("strip:{kind}:{target}"),
            kind: "strip".to_string(),
            frozen_payload: String::new(),
            durability_class: mc_core::DurabilityClass::Lineage,
            reset_rule: String::new(),
        });
    }
    // Live arrays: each subset of a few ids, with block counts 1..=3 and duplicated
    // message ids whose counts differ.
    for mask in 0u32..(1 << 6) {
        for blocks in 1..=3usize {
            let mut request = req("strip-hostile", "cfg", Vec::new());
            for (bit, mid) in ["", "m#1", "m", "a#", "#0", "m#1#2"].iter().enumerate() {
                if mask & (1 << bit) == 0 {
                    continue;
                }
                let mut message = item("placeholder", bit as u64 + 1, "text");
                message.mid = (*mid).to_string();
                for _ in 1..(blocks + bit) % 3 + 1 {
                    message.ck.content.push(message.ck.content[0].clone());
                }
                request.messages.push(message.clone());
                if bit % 2 == 0 {
                    // The same id again with one more block.
                    message.ck.content.push(message.ck.content[0].clone());
                    request.messages.push(message);
                }
            }
            assert_eq!(
                surviving_strip_units(&core, &request),
                surviving_strip_units_reference(&core, &request),
                "mask {mask:#b} blocks {blocks}"
            );
        }
    }
}

fn indexed_compartment(sequence: i64, start: u64, end: u64) -> StoredCompartment {
    StoredCompartment {
        sequence,
        start_message: start as i64,
        end_message: end as i64,
        start_message_id: format!("m{start}#0"),
        end_message_id: format!("m{end}#0"),
        title: format!("compartment {sequence}"),
        content: format!("work from {start} to {end}"),
        p1: Some(format!("work from {start} to {end}")),
        importance: 50,
        created_at: 1_780_000_000_000 + sequence,
        ..Default::default()
    }
}

/// A historian publication landing between two compartment reads of one fold. Before
/// the fold reused its coverage-guard rows, the guard checked the first read while
/// compose rendered (and reported coverage from) the second. The guard then saw live
/// blocks inside the newly published range as uncovered and failed the fold with a
/// coverage gap. Composing from the guard's rows keeps the rendered history, the
/// covered system messages and the guard on one snapshot; the newer row is picked up
/// by the next fold.
#[test]
fn a_publication_between_reads_cannot_split_the_fold_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let session = "ses_review_race";
    let rows = (0..10)
        .map(|index| indexed_compartment(index + 1, index as u64 * 9 + 1, index as u64 * 9 + 9))
        .collect::<Vec<_>>();
    store.replace_compartments(session, &rows).unwrap();
    let messages = (1..=200)
        .map(|ordinal| {
            item(
                &format!("m{ordinal}"),
                ordinal,
                &format!("message {ordinal}"),
            )
        })
        .collect::<Vec<_>>();
    let projection = crate::ck_wire::project_messages(&messages).unwrap();
    let live = projection.blocks.iter().collect::<Vec<_>>();

    let guard_rows = store.load_compartments(session).unwrap();
    store
        .append_compartments(session, &[indexed_compartment(11, 91, 99)])
        .unwrap();
    let second_read = store.load_compartments(session).unwrap();

    let guard_end = coverage_bounds_from_compartments(&guard_rows)
        .unwrap()
        .map(|(_, end)| end);
    let second_end = coverage_bounds_from_compartments(&second_read)
        .unwrap()
        .map(|(_, end)| end);
    assert_eq!((guard_end, second_end), (Some(90), Some(99)));
    // Split snapshot, as when compose re-read the rows: the guard's rows end at 90 but
    // coverage comes from the second read, ending at 99, so ordinal 91 looks uncovered.
    let stray =
        first_uncovered_live_block(&guard_rows, &live, second_end).map(|block| block.ordinal());
    assert_eq!(stray, Some(91), "the split snapshot reports a spurious gap");
    // One snapshot, as when compose reuses the guard's rows: checked against their own
    // coverage end, no block is uncovered.
    assert_eq!(
        first_uncovered_live_block(&guard_rows, &live, guard_end).map(|b| b.ordinal()),
        None
    );
    let inputs = crate::m0_compose::M0ComposeInputs {
        score_selector: mc_store::ScoreSelector::Latest,
        session_id: session,
        project_path: "git:review-race",
        project_directory: "/nonexistent-docs",
        now_ms: 1_790_000_000_000,
        history_budget_tokens: 50_000.0,
        covered_system_messages: &[],
        memory_enabled: false,
        memory_budget_tokens: 0.0,
        user_profile_budget_tokens: 0.0,
        inject_docs: false,
        temporal_awareness: false,
        mural: None,
    };
    let mut timings = crate::m0_compose::ComposeTimings::default();
    let reused = crate::m0_compose::compose_m0_with_score_snapshot(
        &store,
        &inputs,
        &mc_store::CompartmentScoreSnapshot::base(guard_rows),
        mc_tokenizer::estimate_tokens,
        true,
        &mut timings,
    )
    .unwrap();
    assert_eq!(reused.coverage_ordinal, Some(90));
    assert!(!reused.m0_bytes.contains("work from 91 to 99"));
    let reread = crate::m0_compose::compose_m0_from_store_timed(
        &store,
        &inputs,
        mc_tokenizer::estimate_tokens,
        true,
        &mut timings,
    )
    .unwrap();
    assert_eq!(reread.coverage_ordinal, Some(99));
    assert!(reread.m0_bytes.contains("work from 91 to 99"));
}

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

/// This thread's on-CPU and run-queue nanoseconds from Linux schedstat, or None where
/// the kernel does not expose it.
fn thread_schedstat() -> Option<(u64, u64)> {
    let text = std::fs::read_to_string("/proc/thread-self/schedstat").ok()?;
    let mut fields = text
        .split_whitespace()
        .map(|field| field.parse::<u64>().ok());
    Some((fields.next()??, fields.next()??))
}

fn percentile(samples: &mut [f64], quantile: f64) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    samples.sort_by(f64::total_cmp);
    let index = ((samples.len() - 1) as f64 * quantile).round() as usize;
    samples[index]
}

/// Measures how long one long session's passes wait on the store while other
/// sessions run passes on the same `McStore`. Two probe threads time trivial reads:
/// `single_store_marker` takes only the `store.db` connection mutex;
/// `load_compartment_boundaries` of an absent session takes `context.db`'s reader
/// mutex and then, to overlay cached host coordinates, the `store.db` mutex as well.
/// Their latency is the lock wait any caller sees. A third probe times a 1 ms sleep
/// and takes no lock: when it stalls too, the whole process was stalled (CPU quota
/// throttling or memory pressure), not one mutex. Probes print every stall over
/// 50 ms with its offset from the start, as do the measured passes, so stalls can be
/// matched. Each measured pass also splits its wall time into on-CPU, run-queue and
/// blocked time from Linux schedstat. Run in
/// release on Linux:
/// `MC_REVIEW_BACKGROUND=6 cargo test -p mc-module --release --lib
/// store_lock_wait_under_background_sessions -- --ignored --nocapture`.
#[test]
#[ignore = "release-mode measurement; prints lock-wait timings"]
fn store_lock_wait_under_background_sessions() {
    let compartments = env_usize("MC_REVIEW_COMPARTMENTS", 2_300);
    let background = env_usize("MC_REVIEW_BACKGROUND", 6);
    let background_compartments = env_usize("MC_REVIEW_BG_COMPARTMENTS", 600);
    let background_live_covered = env_usize("MC_REVIEW_BG_LIVE_COVERED", 64) as u64;
    let background_tail = env_usize("MC_REVIEW_BG_TAIL", 1_500) as u64;
    let cycles = env_usize("MC_REVIEW_CYCLES", 5);
    let mut fixture = LargeSession::new(0x5eed, compartments, 65, 300, 64, 2_165, true);
    fixture.history_budget_tokens = 98_000.0;
    fixture.run();
    let stop = std::sync::atomic::AtomicBool::new(false);
    let ready = std::sync::Barrier::new(background + 4);
    let origin = Instant::now();
    let offset_ms = |at: Instant| (at - origin).as_secs_f64() * 1000.0;
    let probe = |label: &'static str, read: &(dyn Fn() + Sync)| {
        ready.wait();
        let mut samples = Vec::new();
        while !stop.load(std::sync::atomic::Ordering::Relaxed) {
            let started = Instant::now();
            read();
            let latency = started.elapsed().as_secs_f64() * 1000.0;
            if latency > 50.0 {
                eprintln!(
                    "stall {label} at_ms={:.0} latency_ms={latency:.1}",
                    offset_ms(started)
                );
            }
            samples.push(latency);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        let count = samples.len();
        let total: f64 = samples.iter().sum();
        let (p50, p99, max) = (
            percentile(&mut samples, 0.5),
            percentile(&mut samples, 0.99),
            percentile(&mut samples, 1.0),
        );
        eprintln!(
            "lock-probe {label} samples={count} p50_ms={p50:.3} p99_ms={p99:.3} max_ms={max:.1} sum_ms={total:.1}"
        );
    };
    std::thread::scope(|scope| {
        let store_db = std::sync::Arc::clone(&fixture.store);
        let context_db = std::sync::Arc::clone(&fixture.store);
        let probe = &probe;
        scope.spawn(move || {
            probe("store.db", &move || {
                store_db.single_store_marker().unwrap();
            })
        });
        scope.spawn(move || {
            probe("no-lock-sleep-1ms", &|| {
                std::thread::sleep(std::time::Duration::from_millis(1));
            })
        });
        scope.spawn(move || {
            probe("context.db-reader", &move || {
                context_db
                    .load_compartment_boundaries("ses_review_probe_absent")
                    .unwrap();
            })
        });
        let workers = (0..background)
            .map(|index| {
                let store = std::sync::Arc::clone(&fixture.store);
                let (stop, ready) = (&stop, &ready);
                scope.spawn(move || {
                    let mut other = LargeSession::new_in(
                        store,
                        None,
                        1_000 + index as u64,
                        background_compartments,
                        65,
                        0,
                        background_live_covered,
                        background_tail,
                        false,
                    );
                    other.run();
                    ready.wait();
                    let mut commits = Vec::new();
                    let mut passes = 0usize;
                    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                        other.append_messages(10);
                        if passes % 6 == 5 {
                            other.publish_compartment(200);
                        }
                        if passes % 9 == 8 {
                            other.request_fold();
                        } else if passes % 5 == 4 {
                            other.request_soft();
                        }
                        let started = Instant::now();
                        let response = other.run();
                        if let Some(timings) = response.timings.as_ref() {
                            eprintln!(
                                "background={index} pass at_ms={:.0} total_ms={:.1} store_commit_ms={:.1}",
                                offset_ms(started),
                                timings.total,
                                timings.store_commit
                            );
                        }
                        commits.push(response.timings.as_ref().map_or(0.0, |t| t.store_commit));
                        passes += 1;
                    }
                    let total: f64 = commits.iter().sum();
                    let p50 = percentile(&mut commits, 0.5);
                    let max = percentile(&mut commits, 1.0);
                    eprintln!(
                        "background={index} passes={passes} store_commit_p50_ms={p50:.1} store_commit_max_ms={max:.1} store_commit_sum_ms={total:.1}"
                    );
                })
            })
            .collect::<Vec<_>>();
        ready.wait();
        for cycle in 0..cycles {
            fixture.append_messages(80);
            assert!(fixture.publish_compartment(200));
            for kind in ["defer", "soft", "fold"] {
                match kind {
                    "soft" => fixture.request_soft(),
                    "fold" => fixture.request_fold(),
                    _ => {}
                }
                let before = thread_schedstat();
                let started = Instant::now();
                let at = offset_ms(started);
                let response = fixture.run();
                let wall = started.elapsed().as_secs_f64() * 1000.0;
                let after = thread_schedstat();
                let (cpu, runq) = match (before, after) {
                    (Some(before), Some(after)) => (
                        (after.0 - before.0) as f64 / 1e6,
                        (after.1 - before.1) as f64 / 1e6,
                    ),
                    _ => (f64::NAN, f64::NAN),
                };
                let timings = response.timings.as_ref().unwrap();
                eprintln!(
                    "measured c{cycle}-{kind} at_ms={at:.0} decision={} wall_ms={wall:.1} cpu_ms={cpu:.1} runq_ms={runq:.1} blocked_ms={:.1} compose_m0m1={:.1} state_evolution={:.1} store_commit={:.1} total={:.1}",
                    response.decision,
                    wall - cpu - runq,
                    timings.compose_m0m1,
                    timings.state_evolution,
                    timings.store_commit,
                    timings.total,
                );
            }
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        for worker in workers {
            worker.join().unwrap();
        }
    });
}
