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
    let store =
        Arc::new(McStore::open_for_test(&dev_descriptor_at(data_home.to_str().unwrap())).unwrap());
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
