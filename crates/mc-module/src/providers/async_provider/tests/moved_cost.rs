//! Moved sessions in the same process-CPU cost gate as ordinary covered sessions.
use super::*;
use crate::providers::async_provider::scaling_tests::{
    phase_stats, phases, rss, save_meter, MovedCostRow, MovedCostSample,
};
use std::sync::atomic::{AtomicU64, Ordering};

/// A byte-paged runner, rather than the small fixed pages used by functional
/// tests. Seeking starts with a binary search so recovery does not benchmark a
/// fake runner repeatedly scanning the retained prefix.
struct CostRunner {
    served: Arc<Served>,
    cut: u64,
    requests: Mutex<Vec<u64>>,
    rows: AtomicU64,
    bytes: AtomicU64,
}

#[async_trait]
impl session_resolver::ProviderRunner for CostRunner {
    async fn call_for_identity(
        &self,
        _: &crate::route_targets::SessionRunnerRoute,
        identity: &session_resolver::RunnerBindIdentity,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        self.call(
            &identity.project_root,
            &identity.session,
            method,
            params,
            budget,
        )
        .await
    }

    async fn call(
        &self,
        root: &Path,
        session: &str,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        if method != "session.read" {
            return self
                .served
                .call(root, session, method, params, budget)
                .await;
        }
        let from = params["from_ordinal"].as_u64().unwrap();
        assert!(
            from >= self.cut,
            "moved read below cut: {from} < {}",
            self.cut
        );
        self.requests.lock().unwrap().push(from);
        let budget = params["max_bytes"].as_u64().unwrap_or(1_048_576) as usize;
        let entries = self.served.entries.lock().unwrap();
        let start = entries.partition_point(|entry| entry.ordinal < from);
        let mut messages = Vec::new();
        let mut bytes = 0;
        for entry in &entries[start..] {
            let entry = serve_descriptors(entry);
            let size = serde_json::to_vec(&entry).unwrap().len();
            if !messages.is_empty() && bytes + size > budget {
                break;
            }
            messages.push(entry);
            bytes += size;
        }
        self.rows
            .fetch_add(messages.len() as u64, Ordering::Relaxed);
        self.bytes.fetch_add(bytes as u64, Ordering::Relaxed);
        let lineage = self.served.lineage.lock().unwrap().clone();
        let mut page = ReadPage::new(&lineage, messages);
        if start + page.messages.len() < entries.len() {
            let next = page.messages.last().unwrap().ordinal + 1;
            page = page.with_next_from_ordinal(next);
        }
        Ok(serde_json::to_value(page).unwrap())
    }
}

#[derive(Debug)]
struct Shape {
    total: usize,
    window: usize,
    history: usize,
    summaries: usize,
    returned: usize,
    applied_drops: usize,
}

impl Shape {
    fn new(total: usize, window: usize) -> Self {
        assert!(total > window);
        let history = total - window;
        assert!(history.is_multiple_of(2), "the cut must be a user turn");
        Self {
            total,
            window,
            history,
            summaries: (history * 92 / 5340).max(1),
            returned: (window * 187 / 3750).max(1) | 1,
            applied_drops: window * 2785 / 3750,
        }
    }
}

#[test]
fn moved_gate_keeps_the_same_3750_row_window_as_history_grows() {
    for (total, history, summaries) in [(4750, 1000, 17), (150_000, 146_250, 2519)] {
        let shape = Shape::new(total, 3750);
        assert_eq!(shape.history, history);
        assert_eq!(shape.window, 3750);
        assert_eq!(shape.summaries, summaries);
        assert_eq!(shape.returned, 187);
        assert_eq!(shape.applied_drops, 2785);
    }
}

/// History determines imported summaries; the independently bounded window
/// determines raw rows, the returned band and carried applied drops. All
/// contents are generated, not copied from a real conversation.
fn stores(dir: &Path, shape: &Shape) -> (StorePaths, String) {
    let (cut, summaries, returned) = (shape.history, shape.summaries, shape.returned);
    let paths = fixture::write_synthetic_stores(
        dir,
        &fixture::Synthetic {
            messages: shape.total,
            tail: shape.window,
            text_bytes: 64,
            compartments: summaries,
        },
    );
    let session = fixture::SYNTHETIC_SESSION.to_owned();
    let mut conn = rusqlite::Connection::open(&paths.context_db).unwrap();
    let tx = conn.transaction().unwrap();
    tx.execute("DELETE FROM compartments", []).unwrap();
    for sequence in 1..=summaries + 1 {
        let (start, end) = if sequence > summaries {
            (cut, cut + returned - 1)
        } else {
            (
                (sequence - 1) * cut / summaries,
                sequence * cut / summaries - 1,
            )
        };
        tx.execute(
            "INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,importance,legacy,created_at,harness)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8,50,0,1,'opencode')",
            rusqlite::params![session, sequence, start + 1, end + 1,
                format!("msg_{start:07}"), format!("msg_{end:07}"), format!("history {sequence}"),
                format!("Imported history {sequence}: durable decision for turns {start} through {end}.")],
        ).unwrap();
    }
    tx.execute("UPDATE session_meta SET compaction_marker_state=json_set(compaction_marker_state,'$.targetEndMessageId',?1)", [format!("msg_{:07}", cut + returned - 1)]).unwrap();
    tx.execute("UPDATE tags SET status='active'", []).unwrap();
    tx.execute(
        "UPDATE tags SET status='dropped' WHERE tag_number IN (
            SELECT tag_number FROM tags
            WHERE (tool_owner_message_id >= ?1 OR (type='message' AND message_id >= ?1))
              AND tag_number NOT IN (SELECT tag_id FROM pending_ops)
            ORDER BY tag_number LIMIT ?2)",
        rusqlite::params![format!("msg_{cut:07}"), shape.applied_drops],
    )
    .unwrap();
    tx.commit().unwrap();
    let plan = offline_move::plan(&paths, &session).unwrap();
    assert_eq!(plan.message_count, cut);
    assert_eq!(plan.record.compartments.len(), summaries);
    assert_eq!(plan.dropped_summaries.len(), 1);
    assert_eq!(plan.returned_raw.len(), returned);
    assert_eq!(
        plan.record
            .drops
            .iter()
            .filter(|drop| drop.kind == offline_move::DropKind::Applied)
            .count(),
        shape.applied_drops
    );
    (paths, session)
}

fn setup(session: &str) -> Value {
    let mut request = setup_request(session, "fixture");
    request["context_window"] = json!(1_000_000);
    request
}

const SETUP_PHASES: [&str; 2] = ["moved:setup_dispatch", "moved:setup_decode"];

/// Separate provider dispatch from decoding its prepared response. These are
/// test-driver boundaries, not invented subphases inside the Setup handler.
async fn live_setup(arm: &Arm, request: Value) -> Value {
    let reference = arm.reference();
    let outcome = {
        let _timer = save_meter::start_kind(&reference, SETUP_PHASES[0]);
        arm.h
            .dispatch_value(
                CHANNEL,
                json!({"method":"compaction.setup","params":request}),
            )
            .await
    };
    let _timer = save_meter::start_kind(&reference, SETUP_PHASES[1]);
    response(outcome)
}

async fn advance(arm: &Arm, seq: u64, applied: Option<u64>) -> String {
    let (ordinal, digest) = {
        let entries = arm.runner.entries.lock().unwrap();
        let last = entries.last().unwrap();
        (
            last.ordinal,
            contract::digest::content_digest(&last.message),
        )
    };
    let mut notice = notice::AdvanceNotice::new(
        arm.reference(),
        seq,
        LINEAGE,
        ordinal,
        digest,
        1_000,
        "fixture",
    )
    .with_window(1_000_000);
    if let Some(version) = applied {
        notice = notice.with_applied_view_version(version);
    }
    let mut headers = notice.to_headers();
    headers.insert("lineage_id".into(), LINEAGE.into());
    let message = cortexkit_bus_trait::Message {
        subject: notice::event_subject("fixture", MODULE, notice::ADVANCED_EVENT),
        id: bus_id(&arm.reference(), "advanced", seq),
        digest: notice.digest().parse().unwrap(),
        headers,
    };
    let mut progress = None;
    let outcome = loop {
        let outcome = arm.h.advance_compaction("fixture", &message).await;
        if !matches!(&outcome, Err(HandlerOutcome::Error { code, message })
            if code == "transient" && message.starts_with("async read incomplete;"))
        {
            break outcome;
        }
        // Match the bus's retry of the same notice after a resumable read.
        let state = arm.state();
        assert_eq!(state.partial_read_seq, Some(seq));
        let next = *state.entries.last_key_value().unwrap().0;
        assert!(progress.is_none_or(|previous| next > previous));
        progress = Some(next);
    };
    arm.settle().await;
    outcome.map_or_else(|error| format!("{error:?}"), |()| "ok".into())
}

async fn measure<T>(
    name: &str,
    reference: &str,
    runner: Option<&CostRunner>,
    baseline_rss: u64,
    work: impl std::future::Future<Output = T>,
) -> (T, MovedCostRow) {
    #[cfg(target_os = "linux")]
    std::fs::write("/proc/self/clear_refs", "5").expect("reset peak before measured work");
    let before = phase_stats(reference);
    let setup_before = SETUP_PHASES.map(|kind| save_meter::read_kind(reference, kind));
    let reads = runner.map_or(0, |runner| runner.requests.lock().unwrap().len());
    let rows = runner.map_or(0, |runner| runner.rows.load(Ordering::Relaxed));
    let bytes = runner.map_or(0, |runner| runner.bytes.load(Ordering::Relaxed));
    let wall = Instant::now();
    let thread = cpu_time::ThreadTime::now();
    let process = cpu_time::ProcessTime::now();
    let result = work.await;
    let timing = (
        wall.elapsed().as_secs_f64() * 1e3,
        thread.elapsed().as_secs_f64() * 1e3,
        process.elapsed().as_secs_f64() * 1e3,
    );
    let peak = rss().0;
    let mut profile = phases(reference, &before);
    for (kind, before) in SETUP_PHASES.into_iter().zip(setup_before) {
        let after = save_meter::read_kind(reference, kind);
        profile.push_str(&format!(
            " {kind}={:.3}cpu-ms/{:.3}wall-ms/{}",
            (after.cpu_nanos - before.cpu_nanos) as f64 / 1e6,
            (after.wall_nanos - before.wall_nanos) as f64 / 1e6,
            after.saves - before.saves
        ));
    }
    (
        result,
        MovedCostRow {
            name: name.into(),
            timings: vec![timing],
            read_rows: runner.map_or(0, |runner| runner.rows.load(Ordering::Relaxed) - rows),
            read_bytes: runner.map_or(0, |runner| runner.bytes.load(Ordering::Relaxed) - bytes),
            read_requests: runner.map_or_else(Vec::new, |runner| {
                runner.requests.lock().unwrap()[reads..].to_vec()
            }),
            peak_rss_bytes: peak,
            peak_rss_net_bytes: peak.saturating_sub(baseline_rss),
            resident_record_bytes: 0,
            phases: profile.clone(),
            phase_samples: vec![profile],
            window_rows: vec![0],
        },
    )
}

fn record_bytes(arm: &Arm) -> u64 {
    let conn = inspection_sql(arm.store_dir.join("store.db"));
    conn.query_row(
        "SELECT coalesce((SELECT length(state_json) FROM mc_async_compaction WHERE session_ref=?1),0)
         + coalesce((SELECT sum(length(entry_json)+length(index_json)) FROM mc_async_compaction_entries WHERE session_ref=?1),0)",
        [arm.reference()], |row| row.get(0),
    ).unwrap()
}

fn no_rows_below_cut(arm: &Arm, cut: u64) {
    let conn = inspection_sql(arm.store_dir.join("store.db"));
    let below: u64 = conn
        .query_row(
            "SELECT count(*) FROM mc_async_compaction_entries WHERE session_ref=?1 AND ordinal<?2",
            rusqlite::params![arm.reference(), cut],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        below, 0,
        "moved session must retain no raw rows below its checkpoint"
    );
}

/// Each child owns a new moved store and a new process high-water mark. Setup
/// and adoption use five such children per size, just like the ordinary row.
#[tokio::test(flavor = "current_thread")]
#[ignore = "child of cost_rule_150k_vs_1k; Linux process-CPU benchmark"]
async fn moved_session_cost_child() {
    let _clock = crate::tests::fixed_clock();
    let size = std::env::var("MC_MOVED_COST_SIZE")
        .expect("cost parent supplies size")
        .parse::<usize>()
        .unwrap();
    let window = std::env::var("MC_MOVED_COST_WINDOW")
        .unwrap_or_else(|_| "3750".into())
        .parse::<usize>()
        .unwrap();
    let shape = Shape::new(size, window);
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (paths, session) = stores(store.path(), &shape);
    let reference = runner_session_ref(MODULE, "opencode", &session);
    let plan = offline_move::plan(&paths, &session).unwrap();
    let cut = plan.message_count as u64;
    let compartments = plan.record.compartments.len();
    let vector: Value = serde_json::from_str(
        cortexkit_role_llm_runner::vectors::file("message-checkpoint.json").unwrap(),
    )
    .unwrap();
    let mut head = vector["worked_head_cut"]["head_cut"].clone();
    head["mid"] = json!(plan.p);
    let certificate = store.path().join("head-cut.json");
    std::fs::write(
        &certificate,
        json!({"message_count":cut,"head_cut":head}).to_string(),
    )
    .unwrap();
    drop(plan);
    let baseline = rss().1;
    let (moved, move_row) = measure("offline move", &reference, None, baseline, async {
        offline_move::run_with_head_cut(&paths, &session, &certificate, &fixture::NoHolders, None)
    })
    .await;
    moved.unwrap();
    let served = served_entries(&paths.opencode_db, &session)
        .into_iter()
        .filter(|entry| entry.ordinal >= cut)
        .collect::<Vec<_>>();
    assert_eq!(served.first().unwrap().ordinal, cut);
    assert_eq!(served.len(), size - cut as usize);
    assert_eq!(
        served.len(),
        window,
        "history must not enlarge the retained window"
    );
    pin_history_generation(&paths.context_db, &session, &[0, 1]);
    let pages = served
        .chunks(350)
        .enumerate()
        .map(|(index, chunk)| {
            let page = ReadPage::new(LINEAGE, chunk.iter().map(serve_descriptors).collect());
            let page = if (index + 1) * 350 < served.len() {
                page.with_next_from_ordinal(chunk.last().unwrap().ordinal + 1)
            } else {
                page
            };
            serde_json::to_string(&page).unwrap() + "\n"
        })
        .collect::<String>();
    let args = command_args(
        project.path(),
        &paths,
        &session,
        &pages,
        &setup_file(project.path(), &setup(&session)),
    );
    drop(pages);
    let baseline = rss().1;
    let (outcome, pass_row) = measure(
        "offline first pass",
        &reference,
        None,
        baseline,
        first_pass(&args, project.path(), &fixture::NoHolders),
    )
    .await;
    let OfflineOutcome::Prepared(report) = outcome.unwrap() else {
        panic!("first pass did not prepare")
    };
    assert_eq!(report.proof.origin, cut);
    assert_eq!(report.proof.count as usize, served.len());
    assert_eq!(report.published_views, 1);
    let retained = served.len();
    let mut arm = Arm::open(
        store.path(),
        project.path(),
        &session,
        Served::new(served, 350),
        config(),
    );
    let runner = Arc::new(CostRunner {
        served: arm.runner.clone(),
        cut,
        requests: Mutex::new(Vec::new()),
        rows: AtomicU64::new(0),
        bytes: AtomicU64::new(0),
    });
    Arc::get_mut(&mut arm.h).unwrap().provider_runner = runner.clone();
    no_rows_below_cut(&arm, cut);
    let baseline = rss().1;
    let (answer, mut setup_row) = measure(
        "live Setup",
        &reference,
        Some(&runner),
        baseline,
        live_setup(&arm, setup(&session)),
    )
    .await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_eq!(answer["checkpoint"]["message_count"], json!(cut));
    assert_eq!(answer["initial"]["range"], json!({"from":cut,"to":size}));
    assert_eq!(
        setup_row.read_rows, 0,
        "prepared Setup must not read the transcript"
    );
    setup_row.resident_record_bytes = record_bytes(&arm);
    setup_row.window_rows[0] = retained;
    drop(answer);
    let (outcome, mut adopt_row) = measure(
        "first adopting notice",
        &reference,
        Some(&runner),
        baseline,
        advance(&arm, 1, None),
    )
    .await;
    assert_eq!(outcome, "ok");
    assert!(super::super::super::offline_first_pass::adopted(
        &arm.state()
    ));
    assert_eq!(
        arm.state().generation,
        0,
        "must adopt, not discard and rebuild"
    );
    no_rows_below_cut(&arm, cut);
    adopt_row.resident_record_bytes = record_bytes(&arm);
    adopt_row.window_rows[0] = retained;
    let version = arm.newest().expect("prepared view");
    assert_eq!(advance(&arm, 2, Some(version)).await, "ok");
    let count = std::env::var("MC_ASYNC_NOTICES")
        .unwrap_or_else(|_| "50".into())
        .parse::<u64>()
        .unwrap();
    assert!(count >= 5, "quiet median needs at least five samples");
    let mut quiet_row: Option<MovedCostRow> = None;
    for seq in 3..3 + count {
        // The same four new messages per quiet notice as the ordinary row.
        for _ in 0..4 {
            let mut entries = arm.runner.entries.lock().unwrap();
            let next = entries.last().unwrap().ordinal + 1;
            let tag = highest_tag(&entries) + 1;
            entries.push(appended(&session, next, tag));
        }
        let (outcome, mut row) = measure(
            "quiet notice",
            &reference,
            Some(&runner),
            baseline,
            advance(&arm, seq, Some(version)),
        )
        .await;
        assert_eq!(outcome, "ok");
        row.window_rows[0] = retained + (seq as usize - 2) * 4;
        if let Some(quiet) = &mut quiet_row {
            quiet.timings.extend(row.timings);
            quiet.phase_samples.extend(row.phase_samples);
            quiet.window_rows.extend(row.window_rows);
            quiet.read_rows = quiet.read_rows.max(row.read_rows);
            quiet.read_bytes = quiet.read_bytes.max(row.read_bytes);
            quiet.read_requests.extend(row.read_requests);
            quiet.peak_rss_bytes = quiet.peak_rss_bytes.max(row.peak_rss_bytes);
            quiet.peak_rss_net_bytes = quiet.peak_rss_net_bytes.max(row.peak_rss_net_bytes);
        } else {
            quiet_row = Some(row);
        }
    }
    let mut quiet_row = quiet_row.unwrap();
    quiet_row.resident_record_bytes = record_bytes(&arm);
    no_rows_below_cut(&arm, cut);
    // A new runner lineage has lost its volatile Setup state. The durable
    // checkpoint remains at the adoption cut, so recovery must reread its suffix.
    arm.restart();
    Arc::get_mut(&mut arm.h).unwrap().provider_runner = runner.clone();
    *arm.runner.lineage.lock().unwrap() = "recovered".into();
    arm.runner.head.lock().unwrap()["lineage_id"] = json!("recovered");
    let mut request = setup(&session);
    request["lineage_id"] = json!("recovered");
    let (answer, mut recovery_row) = measure(
        "recovery Setup",
        &reference,
        Some(&runner),
        baseline,
        live_setup(&arm, request),
    )
    .await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_eq!(answer["initial"]["range"]["from"], json!(cut));
    assert_eq!(recovery_row.read_requests.first(), Some(&cut));
    assert_eq!(
        recovery_row.read_rows as usize,
        retained + count as usize * 4
    );
    recovery_row.resident_record_bytes = record_bytes(&arm);
    recovery_row.window_rows[0] = retained + count as usize * 4;
    no_rows_below_cut(&arm, cut);
    let sample = MovedCostSample {
        size: size as u64,
        cut,
        compartments,
        retained,
        applied_drops: shape.applied_drops,
        context_window: 1_000_000,
        rows: vec![
            setup_row,
            adopt_row,
            quiet_row,
            recovery_row,
            move_row,
            pass_row,
        ],
    };
    eprintln!("MOVED_COST {}", serde_json::to_string(&sample).unwrap());
}
