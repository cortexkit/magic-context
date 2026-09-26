//! Adversarial gate over the host-runner claim lane: the arrangement where a
//! transform pass queues a historian run and a separate host process claims it,
//! runs the completion, and reports back.
//!
//! Every test drives the real dispatcher, the real store and the real restart
//! path. Each one settles one question about what survives a dead claimant, a
//! module restart, or a second project sharing this machine's store. Where a test
//! records behaviour nobody promised, its name says what it observed rather than
//! what it approves of.

use super::*;
use rusqlite::Connection;

const A2_AWAIT_BUDGET_MS: i64 = 660_000;

/// One claim queue row, in the columns a gate reads.
struct GateQueueRow {
    run_id: String,
    phase: String,
    claimant: Option<String>,
    token: Option<String>,
    chunk_fingerprint: String,
    report_kind: Option<String>,
    attempt: i64,
}

/// Read the claim queue straight out of the store file, read-only.
///
/// The public API deliberately hides most of these columns from a claimant; a
/// gate has to see them to tell "parked" from "on offer" and to prove a token was
/// cleared rather than merely superseded.
fn gate_queue_rows(data_home: &std::path::Path) -> Vec<GateQueueRow> {
    let path = sqlite_store_path(data_home.to_str().unwrap(), DEFAULT_MODULE_ID);
    let conn = Connection::open(&path).unwrap();
    let mut statement = conn
        .prepare(
            "SELECT run_id, phase, claimant_instance_id, coordinator_token,
                    chunk_fingerprint, report_kind, attempt
               FROM mc_historian_pending_run ORDER BY run_id",
        )
        .unwrap();
    let rows = statement
        .query_map([], |row| {
            Ok(GateQueueRow {
                run_id: row.get(0)?,
                phase: row.get(1)?,
                claimant: row.get(2)?,
                token: row.get(3)?,
                chunk_fingerprint: row.get(4)?,
                report_kind: row.get(5)?,
                attempt: row.get(6)?,
            })
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    rows
}

/// Park a session on a firing and queue its run for a claimant without running a
/// pass, for the sequences that never publish and so never need the chunk this
/// session would really have produced.
fn a2_queue_run(
    store: &McStore,
    session_id: &str,
    run_id: &str,
    project_path: &str,
    user_prompt: &str,
    now_ms: i64,
) {
    let loaded = store.load(session_id).unwrap();
    let mut meta = loaded.meta.clone();
    meta.historian = HistorianDurableState {
        state: HistorianPhase::Firing,
        firing_seq: 1,
        chunk_range: Some(HistorianChunkRange {
            from_ordinal: 1,
            to_ordinal: 3,
        }),
        chunk_fingerprint: format!("fp-{session_id}"),
        fired_at_ms: Some(now_ms),
        ..HistorianDurableState::default()
    };
    store
        .commit(session_id, loaded.row_version, &loaded.core, &meta)
        .unwrap();
    store
        .publish_pending_historian_run(&mc_store::NewHistorianPendingRun {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            project_path: project_path.to_string(),
            firing_seq: 1,
            chunk_fingerprint: format!("fp-{session_id}"),
            system_prompt: "gate-system-prompt".to_string(),
            user_prompt: user_prompt.to_string(),
            model_chain: vec!["test/first".to_string()],
            await_budget_ms: A2_AWAIT_BUDGET_MS,
            historian_timeout_ms: None,
            now_ms,
        })
        .unwrap();
}

/// Open a module over a given store directory.
///
/// Called twice on one directory this is a restart, and nothing survives except
/// what is on disk. The store is single-writer, so the caller must have dropped
/// the previous handler and its store handle first — which is the point: a
/// restart that could keep the old process's in-memory ledger would prove nothing
/// about the durable path.
fn a2_module_on(
    state: Arc<ProducerState>,
    config: McModuleConfig,
    data_home: &std::path::Path,
    project: &std::path::Path,
) -> (McHandler, Arc<McStore>) {
    let store = Arc::new(McStore::open(&dev_descriptor_at(data_home.to_str().unwrap())).unwrap());
    let handler = McHandler::with_producer_factory_config_resolver(
        Arc::new(TestProducerFactory { state }),
        config,
        Arc::new(MissingSessionResolver),
    );
    handler.store.set(Arc::clone(&store)).ok().unwrap();
    handler.bind_route(7, binding(project.to_str().unwrap(), "ses"));
    (handler, store)
}

fn host_runner_config() -> McModuleConfig {
    let mut config = default_test_config();
    config.historian_runner = Some(HistorianRunnerKind::Host);
    config
}

/// Poll `historian.pending` through the wire until the pass's run shows up.
async fn a2_await_queued_run(handler: &McHandler) -> Value {
    let deadline = std::time::Instant::now() + TEST_WAIT_BUDGET;
    loop {
        let listed =
            call_dispatch_request(handler, json!({ "method": "historian.pending", "v": 1 })).await;
        if let Some(run) = listed["runs"].as_array().and_then(|runs| runs.first()) {
            return run.clone();
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the pass must queue its run for a claimant"
        );
        tokio::time::sleep(TEST_WAIT_POLL).await;
    }
}

/// Two hosts pulling one project: the first claims and is killed mid-completion,
/// the second takes the same run once the lease lapses, and the killed host's
/// report — replayed by hand with the token it still holds — is refused.
///
/// This is the sequence the lease exists for. A host that dies without saying so
/// is indistinguishable from a slow one until its lease runs out, so the module
/// cannot release the run early; and once it does, the dead host's token names an
/// attempt that no longer exists, so its answer must not be the one that lands.
///
/// Exactly one publish is the property on the other side: both hosts ran the same
/// prompt, and only one of the two documents may become a compartment.
#[tokio::test(flavor = "current_thread")]
async fn gate_a_killed_host_loses_the_run_to_the_next_one_and_its_late_report_is_refused() {
    let producer = Arc::new(ProducerState::default());
    let (handler, store, dir, project) = handler_with_store(producer, host_runner_config());
    let project_key = lane_project_key(&store, &project);

    // A real pass fires and queues the run. The firing task in this process is
    // still waiting for a report, which is what makes "exactly one publish"
    // observable here rather than only on the queue row.
    let fired = call_transform(&handler, big_messages()).await;
    assert_eq!(fired["historian"]["fired"], json!(true), "{fired}");
    let queued = a2_await_queued_run(&handler).await;
    let run_id = queued["run_id"].as_str().unwrap().to_string();

    let host_a = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": run_id, "claimant_instance_id": "install-host-a",
        }),
    )
    .await;
    assert_eq!(host_a["ok"], json!(true), "{host_a}");
    assert_eq!(host_a["attempt"], json!(1));
    let token_a = host_a["token"].as_str().unwrap().to_string();
    let lease_end = host_a["claim_deadline_ms"].as_i64().unwrap();
    let prompt = host_a["prompt"]["user"].as_str().unwrap().to_string();

    // Host A is killed here. It never reports and never beats again; from the
    // module's side nothing at all happens until the lease runs out.

    // Inside the lease the run belongs to nobody else, however long host B waits:
    // a slow claimant looks exactly like a dead one from here.
    assert_eq!(
        store
            .claim_historian_run(&project_key, &run_id, "install-host-b", lease_end - 1)
            .unwrap(),
        mc_store::HistorianClaimOutcome::Refused(mc_store::HistorianClaimRefusal::AlreadyClaimed),
    );

    // Past the lease, host B takes the SAME run: same id, same chunk, new attempt.
    let mc_store::HistorianClaimOutcome::Claimed(host_b) = store
        .claim_historian_run(&project_key, &run_id, "install-host-b", lease_end)
        .unwrap()
    else {
        panic!("a lapsed lease must hand the run to the next claimant");
    };
    assert_eq!(host_b.run_id, run_id, "the replacement continues the run");
    assert_eq!(host_b.attempt, 2);
    assert_ne!(host_b.token, token_a);
    assert_eq!(
        host_b.user_prompt, prompt,
        "the chunk is not re-assembled for the replacement"
    );

    // The two hosts produce DIFFERENT documents, so the compartment that lands
    // says which of them was published rather than only how many did.
    let (start, end) = prompt_ordinal_range(&prompt).expect("a claim's prompt names its range");
    let dead_hosts_answer = historian_output(start, end, "the dead host's answer");
    let survivors_answer = historian_output(start, end, "the surviving host's answer");

    // The killed host's report, replayed by hand with the token it still holds.
    let late = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.complete", "v": 1,
            "run_id": run_id, "token": token_a,
            "output": { "text": dead_hosts_answer, "length_capped": false },
        }),
    )
    .await;
    assert_eq!(
        late,
        json!({ "ok": false, "refusal": "superseded_token" }),
        "the dead host's answer describes an attempt that no longer exists"
    );

    // Host B's report is the one that lands, and the firing task publishes it.
    let accepted = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.complete", "v": 1,
            "run_id": run_id, "token": host_b.token,
            "output": { "text": survivors_answer, "length_capped": false },
        }),
    )
    .await;
    assert_eq!(accepted["ok"], json!(true), "{accepted}");
    wait_for_idle(&store).await;

    let compartments = store.load_compartments("ses").unwrap();
    assert_eq!(
        compartments.len(),
        1,
        "two hosts ran the same prompt and exactly one document became a compartment"
    );
    assert!(
        compartments[0]
            .content
            .contains("the surviving host's answer"),
        "the compartment has to be the live claimant's document: {}",
        compartments[0].content
    );
    assert!(
        gate_queue_rows(&dir.path().join("data")).is_empty(),
        "a published run leaves the queue"
    );
    drop(dir);
}

/// A module restart between the claim and the report: the answer is stored on the
/// queue row by a module that never heard of the firing, and the next pass for
/// that session publishes it. A second report for the same attempt, after the
/// publish, is refused.
///
/// The rule under test is that a report with nowhere to go is kept rather than
/// discarded: a fold legitimately runs for minutes, so a module restart inside one
/// is ordinary, and throwing away a provider call the host already paid for is the
/// worse of the two answers.
///
/// The restart is a real second `McHandler` over the same store file, opened only
/// after the first one and its store handle are dropped, so nothing in memory
/// carries the firing across.
#[test]
fn gate_a_report_that_crosses_a_module_restart_is_stored_and_then_published() {
    let producer = Arc::new(ProducerState::default());
    let dir = tempfile::tempdir().unwrap();
    let data_home = dir.path().join("data");
    std::fs::create_dir_all(&data_home).unwrap();
    let project = dir.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let messages = big_messages();

    // Two runtimes rather than two handlers: the firing task the first pass spawns
    // holds the store open, and only dropping the runtime it lives on takes it
    // away. That is what a module process dying does, and the single-writer store
    // lease refuses the second module until it has actually happened.
    let first = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (run_id, token, completion) = first.block_on({
        let producer = Arc::clone(&producer);
        let data_home = data_home.clone();
        let project = project.clone();
        let messages = messages.clone();
        async move {
            let (before, _store_before) =
                a2_module_on(producer, host_runner_config(), &data_home, &project);
            let fired = call_transform(&before, messages).await;
            assert_eq!(fired["historian"]["fired"], json!(true), "{fired}");
            let queued = a2_await_queued_run(&before).await;
            let run_id = queued["run_id"].as_str().unwrap().to_string();
            let claimed = call_dispatch_request(
                &before,
                json!({
                    "method": "historian.claim", "v": 1,
                    "run_id": run_id, "claimant_instance_id": "install-host-a",
                }),
            )
            .await;
            assert_eq!(claimed["ok"], json!(true), "{claimed}");
            let token = claimed["token"].as_str().unwrap().to_string();
            let completion =
                historian_output_for_prompt(claimed["prompt"]["user"].as_str().unwrap());
            (run_id, token, completion)
        }
    });

    // The module dies here, inside the completion window. A fold takes minutes, so
    // this is ordinary rather than exceptional.
    drop(first);

    let second = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    second.block_on(a2_after_the_restart(
        producer, &data_home, &project, messages, run_id, token, completion,
    ));
    drop(second);
    drop(dir);
}

/// The second half of the restart sequence, on the module that came up after it.
async fn a2_after_the_restart(
    producer: Arc<ProducerState>,
    data_home: &std::path::Path,
    project: &std::path::Path,
    messages: Vec<CkIngressMessage>,
    run_id: String,
    token: String,
    completion: String,
) {
    let (after, store_after) = a2_module_on(producer, host_runner_config(), data_home, project);
    let stored = call_dispatch_request(
        &after,
        json!({
            "method": "historian.complete", "v": 1,
            "run_id": run_id, "token": token,
            "output": { "text": completion.clone(), "length_capped": false },
        }),
    )
    .await;
    assert_eq!(
        stored,
        json!({ "ok": true, "accepted": true, "publish": "deferred" }),
        "a report with no firing waiting on it is stored, and the answer says which"
    );
    let rows = gate_queue_rows(data_home);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].phase, "reported");
    assert_eq!(rows[0].report_kind.as_deref(), Some("output"));

    // A stored report is out of everyone else's reach: not offered, not claimable.
    let listed =
        call_dispatch_request(&after, json!({ "method": "historian.pending", "v": 1 })).await;
    assert_eq!(
        listed["runs"].as_array().map(Vec::len),
        Some(0),
        "a run carrying an answer is not offered again: {listed}"
    );

    // The next pass for that session publishes it, through the same code an
    // in-process report goes through.
    let next_pass = call_transform(&after, messages).await;
    assert_eq!(next_pass["status"], "ok", "{next_pass}");
    let deadline = std::time::Instant::now() + TEST_WAIT_BUDGET;
    loop {
        if store_after.load_compartments("ses").unwrap().len() == 1 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the pass after the restart must publish the report the claimant left"
        );
        tokio::time::sleep(TEST_WAIT_POLL).await;
    }
    assert!(
        gate_queue_rows(data_home).is_empty(),
        "a published run leaves the queue"
    );

    // A second report for the same attempt, after the publish.
    let duplicate = call_dispatch_request(
        &after,
        json!({
            "method": "historian.complete", "v": 1,
            "run_id": run_id, "token": token,
            "output": { "text": completion, "length_capped": false },
        }),
    )
    .await;
    assert_eq!(
        duplicate["ok"],
        json!(false),
        "the module takes exactly one answer per run: {duplicate}"
    );
    assert_eq!(
        store_after.load_compartments("ses").unwrap().len(),
        1,
        "and the refused duplicate published nothing"
    );
    drop(after);
}

/// A restart that parked the queue row and died before releasing the session: the
/// next boot puts the SAME run back on offer, and a claimant continues it with the
/// same run id and the same chunk fingerprint.
///
/// The restart path parks the row before releasing the session precisely so a
/// crash between the two leaves a row the next boot can pick up rather than one
/// still advertised to claimants whose session no longer owns it. This drives that
/// window with the real writers: `park_historian_pending_run` writes the phase,
/// restart recovery puts it back, and `historian.claim` takes it.
#[tokio::test(flavor = "current_thread")]
async fn gate_a_parked_row_goes_back_on_offer_on_the_next_boot_with_the_same_run_and_chunk() {
    let producer = Arc::new(ProducerState::default());
    let (handler, store, dir, project) = handler_with_store(producer, host_runner_config());
    let data_home = dir.path().join("data");
    let project_key = lane_project_key(&store, &project);
    // The durable state a restart leaves behind: a queued run whose firing task
    // died with the previous process, so nothing in THIS process is waiting on it.
    let run_id = "run-parked".to_string();
    let fingerprint = "fp-ses".to_string();
    a2_queue_run(
        &store,
        "ses",
        &run_id,
        &project_key,
        "transcript [1-3]",
        now_ms(),
    );

    // The restart path's first write without its second: the row is parked and the
    // session still names the run.
    assert!(store.park_historian_pending_run(&run_id, now_ms()).unwrap());
    let parked_rows = gate_queue_rows(&data_home);
    assert_eq!(parked_rows[0].phase, "parked");

    let hidden =
        call_dispatch_request(&handler, json!({ "method": "historian.pending", "v": 1 })).await;
    assert_eq!(
        hidden["runs"].as_array().map(Vec::len),
        Some(0),
        "a parked row is offered to nobody: {hidden}"
    );
    let refused = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": run_id, "claimant_instance_id": "install-host-a",
        }),
    )
    .await;
    assert_eq!(
        refused,
        json!({ "ok": false, "refusal": "not_pending" }),
        "a claimant that names a parked run anyway is told it is not on offer"
    );

    // Restart recovery: the same row goes back on offer, unchanged.
    let recovery = call_transform(&handler, big_messages()).await;
    assert_eq!(recovery["status"], "ok", "{recovery}");
    let deadline = std::time::Instant::now() + TEST_WAIT_BUDGET;
    loop {
        if gate_queue_rows(&data_home)
            .first()
            .is_some_and(|row| row.phase == "pending")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the boot has to put the parked run back on offer"
        );
        tokio::time::sleep(TEST_WAIT_POLL).await;
    }
    let back = gate_queue_rows(&data_home);
    assert_eq!(back[0].run_id, run_id, "the same run, not a new one");
    assert_eq!(
        back[0].chunk_fingerprint, fingerprint,
        "the run keeps the chunk it already owns across the park"
    );
    assert_eq!(back[0].claimant, None);
    assert_eq!(back[0].token, None);

    let offered =
        call_dispatch_request(&handler, json!({ "method": "historian.pending", "v": 1 })).await;
    assert_eq!(offered["runs"][0]["run_id"], json!(run_id));
    assert_eq!(offered["runs"][0]["chunk_fingerprint"], json!(fingerprint));

    // And a claimant continues the same run rather than starting a new one.
    let claimed = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": run_id, "claimant_instance_id": "install-host-a",
        }),
    )
    .await;
    assert_eq!(claimed["ok"], json!(true), "{claimed}");
    assert_eq!(claimed["run_id"], json!(run_id));
    drop(dir);
}

/// The claim sweep has a production caller: restart recovery runs it, so a row a
/// previous restart parked is deleted once the run it describes is past its own
/// deadline.
///
/// The row under test is one NOTHING else can reach. A restart that parks a row
/// releases its session in the same breath, which clears the run id the adoption
/// path looks the row up through; the session then fires again and takes a new
/// run. The old row is left addressed by nobody, and the sweep is the only thing
/// that walks the queue rather than one session's link into it.
#[tokio::test(flavor = "current_thread")]
async fn gate_restart_recovery_sweeps_a_parked_row_nothing_else_can_reach() {
    let producer = Arc::new(ProducerState::default());
    let (handler, store, dir, project) = handler_with_store(producer, host_runner_config());
    let data_home = dir.path().join("data");
    let project_key = lane_project_key(&store, &project);

    // Queued far enough in the past that its own deadline has already gone by, and
    // parked by the restart that released its session.
    let stale = now_ms() - A2_AWAIT_BUDGET_MS - 60_000;
    a2_queue_run(
        &store,
        "ses",
        "run-abandoned",
        &project_key,
        "transcript",
        stale,
    );
    assert!(store
        .park_historian_pending_run("run-abandoned", stale)
        .unwrap());

    // The session fired again and is on a different run now, so nothing links back
    // to the parked row any more.
    a2_queue_run(
        &store,
        "ses",
        "run-current",
        &project_key,
        "a later transcript",
        now_ms(),
    );
    assert_eq!(
        store
            .load_parked_historian_run("ses")
            .unwrap()
            .map(|parked| parked.run_id)
            .as_deref(),
        Some("run-current"),
        "the abandoned row is unreachable through the session's own link"
    );
    assert_eq!(gate_queue_rows(&data_home).len(), 2);

    // A pass for that session enters restart recovery, which is where the sweep
    // runs. The session is not idle, so the recovery path is reached.
    let response = call_transform(&handler, big_messages()).await;
    assert_eq!(response["status"], "ok", "{response}");

    let deadline = std::time::Instant::now() + TEST_WAIT_BUDGET;
    loop {
        let rows = gate_queue_rows(&data_home);
        if rows.len() == 1 {
            assert_eq!(
                rows[0].run_id, "run-current",
                "the sweep must take the abandoned row and leave the live one"
            );
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "restart recovery must sweep a parked row past its deadline"
        );
        tokio::time::sleep(TEST_WAIT_POLL).await;
    }
    drop(dir);
}

/// Cross-project isolation, driven through the whole op sequence a host loop runs
/// rather than through `pending` alone.
///
/// A claim hands back the folded conversation transcript, and one store serves
/// every project on the machine. A host bound to one project must not be able to
/// discover, claim, beat for, or report on another project's run — and the refusal
/// must be the same one an id that never existed gets, so nothing about the other
/// project leaks through the difference.
#[tokio::test(flavor = "current_thread")]
async fn gate_a_host_bound_to_one_project_cannot_walk_another_projects_run() {
    let producer = Arc::new(ProducerState::default());
    let (handler, store, dir, project) = handler_with_store(producer, host_runner_config());
    let project_key = lane_project_key(&store, &project);
    let now = now_ms();
    a2_queue_run(
        &store,
        "ses",
        "run-mine",
        &project_key,
        "my transcript",
        now,
    );
    a2_queue_run(
        &store,
        "their-session",
        "run-theirs",
        "/some/other/project",
        "a transcript this host must never read",
        now,
    );

    // The other project's run is claimed by its own host, so a token for it exists
    // and this host could present one if it ever learned it.
    let mc_store::HistorianClaimOutcome::Claimed(theirs) = store
        .claim_historian_run("/some/other/project", "run-theirs", "install-theirs", now)
        .unwrap()
    else {
        panic!("the other project's own host must be able to claim its run");
    };

    let listed =
        call_dispatch_request(&handler, json!({ "method": "historian.pending", "v": 1 })).await;
    let ids: Vec<&str> = listed["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|run| run["run_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["run-mine"], "{listed}");

    for request in [
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": "run-theirs", "claimant_instance_id": "install-mine",
        }),
        json!({
            "method": "historian.heartbeat", "v": 1,
            "run_id": "run-theirs", "token": theirs.token,
        }),
        json!({
            "method": "historian.complete", "v": 1,
            "run_id": "run-theirs", "token": theirs.token,
            "output": { "text": historian_output(1, 3, "stolen"), "length_capped": false },
        }),
    ] {
        let answer = call_dispatch_request(&handler, request.clone()).await;
        assert_eq!(
            answer,
            json!({ "ok": false, "refusal": "unknown_run" }),
            "even holding the other project's token, this host is told the run does not exist: \
             {request}"
        );
    }

    // The lane's last write is scoped too, not only the ops in front of it. A
    // report offered straight to the store under this host's project is refused
    // even though the token is the right one for that run, so the scope does not
    // depend on the authorize step in front of it having run first.
    assert_eq!(
        store
            .record_historian_report(
                &project_key,
                "run-theirs",
                &theirs.token,
                &mc_store::HistorianRunReport::Output {
                    text: historian_output(1, 3, "stolen"),
                    length_capped: false,
                },
                now,
            )
            .unwrap(),
        mc_store::HistorianRecordOutcome::Refused(mc_store::HistorianReportRefusal::UnknownRun),
    );

    // The other project's run is untouched: same claimant, same token, no report.
    let rows = gate_queue_rows(&dir.path().join("data"));
    let theirs_row = rows
        .iter()
        .find(|row| row.run_id == "run-theirs")
        .expect("the other project's row is still there");
    assert_eq!(theirs_row.claimant.as_deref(), Some("install-theirs"));
    assert_eq!(theirs_row.token.as_deref(), Some(theirs.token.as_str()));
    assert_eq!(theirs_row.report_kind, None);
    assert_eq!(theirs_row.attempt, 1);

    // The control: this host's own run walks the same sequence and is served.
    let mine = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": "run-mine", "claimant_instance_id": "install-mine",
        }),
    )
    .await;
    assert_eq!(mine["ok"], json!(true), "{mine}");
    assert_eq!(mine["prompt"]["user"], json!("my transcript"));
    let beat = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.heartbeat", "v": 1,
            "run_id": "run-mine", "token": mine["token"],
        }),
    )
    .await;
    assert_eq!(beat["ok"], json!(true), "{beat}");
    drop(dir);
}

/// Eighty-one messages, twenty-seven of them tool arcs, each arc's output large
/// enough that dropping it is worth the reduction's while.
pub(super) fn tool_bearing_messages() -> Vec<CkIngressMessage> {
    let mut messages = Vec::new();
    let mut ordinal = 1u64;
    for index in 0..27 {
        messages.push(ck(
            &format!("m{ordinal}"),
            ordinal,
            &format!("message {ordinal} {}", "word ".repeat(400)),
        ));
        ordinal += 1;
        messages.push(assistant_tool_call(&format!("call-arc{index}"), ordinal));
        ordinal += 1;
        messages.push(tool_result(
            &format!("result-arc{index}"),
            ordinal,
            &format!("tool output {index} {}", "word ".repeat(800)),
        ));
        ordinal += 1;
    }
    messages
}

/// A fixture with tool arcs, run down both runners on an emergency pass, with the
/// dropped-tag counts and both rewrites' sizes printed.
///
/// The earlier measurement used a fixture of plain text, where the emergency
/// reduction has no tool-output tier to drop at all, so its dropped-tag count came
/// back zero without the content-loss half ever being exercised. This fixture
/// carries tool arcs, so the drop tier is real and the number means something.
#[tokio::test(flavor = "current_thread")]
async fn gate_the_a8_emergency_accounting_on_a_fixture_that_has_tool_arcs() {
    let messages = tool_bearing_messages();

    let broca_producer = Arc::new(ProducerState::default());
    let (broca_handler, _broca_store, _broca_dir, _broca_project) =
        handler_with_store(Arc::clone(&broca_producer), default_test_config());
    let broca = call_transform_with_usage(&broca_handler, messages.clone(), 48_000, 50_000).await;
    assert!(
        m0_text(&broca).contains("autonomous summary"),
        "the Broca lane still joins the fold inline on an emergency pass"
    );
    assert!(
        serde_json::to_string(&broca["ck_messages"])
            .unwrap()
            .contains("tool_result"),
        "the served wire has to carry tool arcs, or this measures what A2 already measured"
    );
    let (broca_dropped, broca_messages, broca_bytes) = served_census(&broca);

    let host_producer = Arc::new(ProducerState::default());
    let (host_handler, host_store, _host_dir, host_project) =
        handler_with_store(Arc::clone(&host_producer), host_runner_config());
    let host_project_key = lane_project_key(&host_store, &host_project);
    let host = call_transform_with_usage(&host_handler, messages.clone(), 48_000, 50_000).await;
    assert_eq!(host["historian"]["fired"], json!(true), "{host}");
    assert!(
        !m0_text(&host).contains("autonomous summary"),
        "the host lane serves the emergency reduction, not a fold it waited for"
    );
    let (host_dropped, host_messages, host_emergency_bytes) = served_census(&host);

    let deadline = std::time::Instant::now() + TEST_WAIT_BUDGET;
    let queued = loop {
        let pending = host_store
            .list_pending_historian_runs(&host_project_key, None, now_ms())
            .unwrap();
        if let Some(run) = pending.into_iter().next() {
            break run;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the emergency pass must queue its run for a claimant"
        );
        tokio::time::sleep(TEST_WAIT_POLL).await;
    };
    let claim = call_dispatch_request(
        &host_handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": queued.run_id, "claimant_instance_id": "install-host-a",
        }),
    )
    .await;
    assert_eq!(claim["ok"], json!(true), "{claim}");
    let completion = historian_output_for_prompt(claim["prompt"]["user"].as_str().unwrap());
    let report = call_dispatch_request(
        &host_handler,
        json!({
            "method": "historian.complete", "v": 1,
            "run_id": queued.run_id, "token": claim["token"],
            "output": { "text": completion, "length_capped": false },
        }),
    )
    .await;
    assert_eq!(report["ok"], json!(true), "{report}");
    wait_for_idle(&host_store).await;

    let host_second = call_transform_with_usage(&host_handler, messages, 48_000, 50_000).await;
    assert!(
        m0_text(&host_second).contains("autonomous summary"),
        "the fold lands on the pass after the claimant reported"
    );
    let (host_second_dropped, host_second_messages, host_second_bytes) =
        served_census(&host_second);

    eprintln!(
        "A8 emergency accounting on a tool-bearing fixture: \
         broca dropped_tags={broca_dropped} served_messages={broca_messages} served_bytes={broca_bytes} second_rewrite_bytes=0 | \
         host dropped_tags={host_dropped} served_messages={host_messages} emergency_served_bytes={host_emergency_bytes} \
         second_rewrite_dropped_tags={host_second_dropped} second_rewrite_messages={host_second_messages} second_rewrite_bytes={host_second_bytes}"
    );
}
