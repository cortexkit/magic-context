use super::*;
use crate::user_commands::{self as commands, Request};
use cortexkit_role_user_commands as wire;
use serde_json::json;

#[path = "user_commands_durable_tests.rs"]
mod durable;

#[path = "user_commands_review_tests.rs"]
mod review_tests;

#[path = "user_commands_tail_tests.rs"]
mod recent_tail;

#[path = "user_commands_audit_tests.rs"]
mod audit;

#[path = "user_commands_version_tests.rs"]
mod version_tests;

#[path = "user_commands_wrapup_tests.rs"]
mod wrapup;

#[path = "user_commands_wrapup_runner_tests.rs"]
mod wrapup_runner;

#[path = "user_commands_owner_tests.rs"]
mod owner;

impl crate::routing::Router for Client {
    async fn select(
        &self,
        _: cortexkit_role_routing::select::SelectRequest,
    ) -> Result<cortexkit_role_routing::select::SelectAnswer, crate::routing::RouteError> {
        unreachable!("commands never route a model")
    }
    async fn report(&self, _: cortexkit_role_routing::report::ReportRequest) {
        unreachable!("commands never report a model")
    }
}

fn ready() -> (Session, Client, Settings) {
    let (mut session, client, _, _, settings) = fixture();
    let mut old = text(1, "old");
    old.parts[0] = Part::new(
        "p",
        PartBody::Text {
            text: "old content ".repeat(400).into(),
        },
    );
    old.parts[0].tag = Some(1);
    session.index.extend(vec![old, text(2, "new prompt")]);
    session.queued.insert(("old".into(), "p".into()));
    session.conditions.last_prompt_tokens = Some(10_000);
    (session, client, settings)
}

fn preview_request(session: &Session, id: &str) -> wire::ModulePreviewRequest {
    wire::ModulePreviewRequest::new(
        id,
        wire::Subject::session(wire::SessionRef::new(
            &session.key.runner,
            &session.key.harness,
            &session.key.session,
        )),
        Default::default(),
        wire::Caller::new("desktop", "operator_app"),
    )
}

async fn preview(
    session: &mut Session,
    client: &Client,
    settings: &Settings,
    id: &str,
) -> wire::Preview {
    let request = preview_request(session, id);
    let body = serde_json::to_vec(&json!({"method":"commands.preview", "params":request})).unwrap();
    let request = commands::decode(&body).unwrap().unwrap();
    serde_json::from_value(
        commands::execute(Some(session), client, settings, request)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn user_commands_digest_is_stable_jcs_over_array_and_manifest_declares_commands() {
    use sha2::{Digest, Sha256};
    let description = commands::describe();
    assert_eq!(description, commands::describe());
    description.check().unwrap();
    assert_eq!(
        description.digest,
        format!(
            "{:x}",
            Sha256::digest(serde_jcs::to_vec(&description.commands).unwrap())
        )
    );
    assert!(!description.commands[1].offers_run());
    let manifest = serde_json::to_value(crate::transport::manifest(crate::MODULE_ID)).unwrap();
    assert!(manifest["capabilities"]["provides"]
        .as_array()
        .unwrap()
        .contains(&json!(wire::PROVIDES)));
    for op in wire::MODULE_OPS {
        assert!(manifest.to_string().contains(op));
    }
}

#[tokio::test]
async fn user_commands_admission_precedes_even_malformed_params_for_all_ops() {
    let module = crate::module::Module::new(Client::default(), Settings::default(), None, None);
    let callers = [
        subc_protocol::Principal::Direct,
        subc_protocol::Principal::Unverified,
        subc_protocol::Principal::Reserved {
            module_id: "callosum".into(),
        },
        subc_protocol::Principal::Reserved {
            module_id: "other-runner".into(),
        },
    ];
    for method in wire::MODULE_OPS {
        for caller in &callers {
            let body = serde_json::to_vec(&json!({"method":method,"params":"malformed"})).unwrap();
            assert_eq!(
                module
                    .command_request(caller, &body)
                    .await
                    .unwrap_err()
                    .code,
                "caller_not_admitted"
            );
            assert_eq!(
                module
                    .command_request(caller, b"not json")
                    .await
                    .unwrap_err()
                    .code,
                "caller_not_admitted"
            );
        }
    }
    let caller = subc_protocol::Principal::Reserved {
        module_id: "occipital".into(),
    };
    assert_eq!(
        module
            .command_request(&caller, b"not json")
            .await
            .unwrap_err()
            .code,
        "invalid_params"
    );
    assert_eq!(
        module
            .command_request(&caller, br#"{"method":"commands.describe","params":{}}"#)
            .await
            .unwrap(),
        serde_json::to_value(commands::describe()).unwrap()
    );
}

#[tokio::test]
async fn user_commands_flush_preview_does_not_drain_and_run_lands_exactly_counted_drops() {
    let (mut session, client, settings) = ready();
    let before = session.durable();
    let p = preview(&mut session, &client, &settings, "flush").await;
    assert!(p.available, "{p:?}");
    assert_eq!(p.facts.as_ref().unwrap()[0].data.value, Some(1.0));
    // 4,800 ASCII bytes cost 1,200 estimated tokens; the placeholder costs
    // six. These fixed numbers catch counting the removed text twice.
    assert_eq!(p.facts.as_ref().unwrap()[1].data.value, Some(1194.0));
    assert_eq!(p.facts.as_ref().unwrap()[2].data.value, Some(0.0));
    assert_eq!(
        before,
        session.durable(),
        "preview cannot advance decisions"
    );
    assert!(client.reads.lock().unwrap().is_empty());
    assert!(client.offered.lock().unwrap().is_empty());
    let request =
        wire::ModuleRunRequest::new(preview_request(&session, "flush"), p.version, "flush-1");

    let answer = commands::execute(
        Some(&mut session),
        &client,
        &settings,
        Request::Run(request.clone()),
    )
    .await
    .unwrap();
    assert_eq!(answer["outcome"], "scheduled");
    assert_eq!(answer["facts"].as_array().unwrap().len(), 3);
    assert_eq!(answer["facts"][0]["value"], 1.0);
    assert_eq!(answer["facts"][1]["value"], 1194.0);
    assert_eq!(answer["facts"][2]["value"], 8806.0);
    assert!(session.queued.is_empty());
    {
        let offers = client.offered.lock().unwrap();
        assert_eq!(offers.len(), 1);
        assert!(offers[0].edits.iter().any(|e| matches!(&e.op, EditOp::Replace { mid, part, value, .. } if mid == "old" && part == "p" && value == "[dropped §1§]")));
    }
    let repeated = commands::execute(
        Some(&mut session),
        &client,
        &settings,
        Request::Run(request.clone()),
    )
    .await
    .unwrap();
    assert_eq!(answer, repeated);
    assert_eq!(client.offered.lock().unwrap().len(), 1);
    let mut conflict = request;
    conflict.caller = wire::Caller::new("phone", "phone");
    let answer = commands::execute(
        Some(&mut session),
        &client,
        &settings,
        Request::Run(conflict),
    )
    .await
    .unwrap();
    assert_eq!(answer["outcome"], "request_conflict");
    assert_eq!(client.offered.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn user_commands_preview_stales_on_queue_summary_or_applied_view() {
    for change in ["queue", "summary", "applied"] {
        let (mut session, client, settings) = ready();
        let p = preview(&mut session, &client, &settings, "flush").await;
        match change {
            "queue" => {
                session.queued.insert(("new prompt".into(), "p".into()));
            }
            "summary" => {
                session.summaries.edit();
            }
            "applied" => session.newest_applied += 1,
            _ => unreachable!(),
        }
        let request =
            wire::ModuleRunRequest::new(preview_request(&session, "flush"), p.version, change);
        assert_eq!(
            session
                .command_run(&client, &settings, &request)
                .await
                .unwrap()
                .outcome,
            "preview_stale"
        );
        assert!(client.offered.lock().unwrap().is_empty());
    }
}

fn hold(session: &mut Session) {
    session.conditions.rules.signed_parts = SignedParts::Bound;
    session.conditions.last_prompt_tokens = Some(10_000);
    let thought: Part = serde_json::from_value(json!({
        "id":"r", "kind":"reasoning", "signed":true, "text_bytes":20000, "digest":""
    }))
    .unwrap();
    let mut entry = Entry::new(3, "thinking", Role::Assistant, 3, vec![thought]);
    entry.reasoning_tokens = Some(cortexkit_role_compaction::tokens::ReasoningTokens::new(
        5000, true,
    ));
    session.index.extend(vec![entry]);
}

#[tokio::test]
async fn user_commands_each_unavailable_reason_and_status_shapes() {
    let (mut session, client, settings) = ready();
    session.tools_only = true;
    for id in ["flush", "status"] {
        assert_eq!(
            preview(&mut session, &client, &settings, id)
                .await
                .reason
                .as_deref(),
            Some("not_managed")
        );
    }
    session.tools_only = false;
    session.summarizing = true;
    assert_eq!(
        preview(&mut session, &client, &settings, "flush")
            .await
            .reason
            .as_deref(),
        Some("summary_running")
    );
    session.summarizing = false;
    session.summary_unshown = true;
    assert!(
        preview(&mut session, &client, &settings, "flush")
            .await
            .available
    );
    session.summary_unshown = false;
    hold(&mut session);
    let held = preview(&mut session, &client, &settings, "flush").await;
    assert_eq!(held.reason.as_deref(), Some("thinking_hold"));
    let request =
        wire::ModuleRunRequest::new(preview_request(&session, "flush"), held.version, "held");
    assert_eq!(
        session
            .command_run(&client, &settings, &request)
            .await
            .unwrap()
            .outcome,
        "thinking_hold"
    );
    assert!(client.offered.lock().unwrap().is_empty());
    let (mut session, client, settings) = ready();
    session.queued.clear();
    assert_eq!(
        preview(&mut session, &client, &settings, "flush")
            .await
            .reason
            .as_deref(),
        Some("nothing_to_land")
    );
    let p = preview(&mut session, &client, &settings, "status").await;
    assert!(p.available);
    assert_eq!(p.facts.as_ref().unwrap().len(), 4);
    assert_eq!(
        p.facts.as_ref().unwrap()[0].data.unit.as_deref(),
        Some("ratio")
    );
    let table = p.table.unwrap();
    assert_eq!(table.columns, ["Now"]);
    assert!(table.rows.iter().any(|r| r.label == "Applied view"));
}

#[tokio::test]
async fn user_commands_push_failure_is_failed_and_replayed_without_retry() {
    for transport in [true, false] {
        let (mut session, client, settings) = ready();
        *client.fail_apply.lock().unwrap() = transport;
        *client.refuse.lock().unwrap() = !transport;
        let p = preview(&mut session, &client, &settings, "flush").await;
        let request =
            wire::ModuleRunRequest::new(preview_request(&session, "flush"), p.version, "failure");

        let a = commands::execute(
            Some(&mut session),
            &client,
            &settings,
            Request::Run(request.clone()),
        )
        .await
        .unwrap();
        assert_eq!(a["outcome"], "failed");
        let offers = client.offered.lock().unwrap().len();
        let b = commands::execute(
            Some(&mut session),
            &client,
            &settings,
            Request::Run(request),
        )
        .await
        .unwrap();
        assert_eq!(a, b);
        assert_eq!(client.offered.lock().unwrap().len(), offers);
    }
}

#[tokio::test]
async fn user_commands_flush_never_folds_even_with_fold_due() {
    let (mut session, client, settings) = ready();
    session.features.summarizer = true;
    let head = session.render_head(&settings);
    session.baseline = session.next_baseline.take();
    session.latest = Some(View::seal(
        1,
        head.into_iter()
            .map(|op| cortexkit_role_compaction::view::Edit::new(1, op))
            .collect(),
    ));
    session.version = 1;
    let baseline = session.baseline.clone();
    let m0 = session
        .latest
        .as_ref()
        .unwrap()
        .edits
        .iter()
        .find(|e| matches!(&e.op, EditOp::Insert { message, .. } if message.id == head::M0_ID))
        .unwrap()
        .op
        .clone();
    session.fold_due = true;
    let p = preview(&mut session, &client, &settings, "flush").await;
    assert!(p.available, "{p:?}");
    let request =
        wire::ModuleRunRequest::new(preview_request(&session, "flush"), p.version, "no-fold");
    assert_eq!(
        session
            .command_run(&client, &settings, &request)
            .await
            .unwrap()
            .outcome,
        "scheduled"
    );
    assert!(
        session.fold_due,
        "only a natural fold may discharge the trigger"
    );
    assert_eq!(
        baseline.as_ref().unwrap().m0,
        session.baseline.as_ref().unwrap().m0
    );
    assert!(session
        .latest
        .as_ref()
        .unwrap()
        .edits
        .iter()
        .any(|e| e.op == m0));
}

#[tokio::test]
async fn user_commands_record_real_handler_samples() {
    use sha2::{Digest, Sha256};
    let (mut session, client, settings) = ready();
    let mut samples = std::collections::BTreeMap::new();
    // This set is the 0.1.0 description: the session commands alone. The
    // full description, with the commands on memories, observations, the
    // dreamer and notes, is in `mc-user-commands-samples-v2`.
    samples.insert(
        "describe.json",
        serde_json::to_value(wire::DescribeReply::new(commands::session_commands()).unwrap())
            .unwrap(),
    );
    {
        let (mut session, client, settings) = wrapup::ready();
        let p = wrapup::preview_keep(&mut session, &client, &settings, None).await;
        samples.insert(
            "wrapup-preview-available.json",
            serde_json::to_value(&p).unwrap(),
        );
        let request = wire::ModuleRunRequest::new(
            wrapup::request(&session, None),
            p.version,
            "sample-wrapup",
        );
        let result = commands::execute(
            Some(&mut session),
            &client,
            &settings,
            Request::Run(request),
        )
        .await
        .unwrap();
        assert_eq!(result["outcome"], "scheduled");
        samples.insert("wrapup-run.json", result);
        let p = wrapup::preview_keep(&mut session, &client, &settings, Some(24)).await;
        assert_eq!(p.reason.as_deref(), Some("within_keep"));
        samples.insert(
            "wrapup-preview-unavailable.json",
            serde_json::to_value(p).unwrap(),
        );
    }
    let p = preview(&mut session, &client, &settings, "flush").await;
    samples.insert(
        "flush-preview-available.json",
        serde_json::to_value(&p).unwrap(),
    );
    samples.insert(
        "status-preview.json",
        serde_json::to_value(preview(&mut session, &client, &settings, "status").await).unwrap(),
    );
    let request = wire::ModuleRunRequest::new(
        preview_request(&session, "flush"),
        p.version,
        "sample-flush",
    );
    let result = commands::execute(
        Some(&mut session),
        &client,
        &settings,
        Request::Run(request),
    )
    .await
    .unwrap();
    assert_eq!(result["outcome"], "scheduled");
    samples.insert("flush-run.json", result);
    for reason in [
        "nothing_to_land",
        "queued_in_recent_tail",
        "thinking_hold",
        "not_managed",
        "summary_running",
    ] {
        let (mut session, client, settings) = ready();
        match reason {
            "nothing_to_land" => session.queued.clear(),
            "queued_in_recent_tail" => {
                (session, _, _) = recent_tail::ready_with_recent_tail();
                session.queued.remove(&("old".into(), "p".into()));
            }
            "thinking_hold" => hold(&mut session),
            "not_managed" => session.tools_only = true,
            "summary_running" => session.summarizing = true,
            _ => unreachable!(),
        }
        let p = preview(&mut session, &client, &settings, "flush").await;
        assert_eq!(p.reason.as_deref(), Some(reason));
        let request = wire::ModuleRunRequest::new(
            preview_request(&session, "flush"),
            p.version.clone(),
            format!("unavailable-{reason}"),
        );
        assert_eq!(
            session
                .command_run(&client, &settings, &request)
                .await
                .unwrap()
                .outcome,
            reason
        );
        samples.insert(
            match reason {
                "nothing_to_land" => "flush-preview-nothing-to-land.json",
                "queued_in_recent_tail" => "flush-preview-queued-in-recent-tail.json",
                "thinking_hold" => "flush-preview-thinking-hold.json",
                "not_managed" => "flush-preview-not-managed.json",
                _ => "flush-preview-summary-running.json",
            },
            serde_json::to_value(p).unwrap(),
        );
        if reason == "not_managed" {
            samples.insert(
                "status-preview-not-managed.json",
                serde_json::to_value(preview(&mut session, &client, &settings, "status").await)
                    .unwrap(),
            );
        }
    }
    let dir = std::env::var_os("MC_USER_COMMAND_SAMPLES_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("testdata/mc-user-commands-samples-v1")
        });
    let update = std::env::var_os("MC_UPDATE_USER_COMMAND_SAMPLES").is_some();
    if update {
        std::fs::create_dir_all(&dir).unwrap();
    }
    let mut sums = String::new();
    for (name, body) in samples {
        let bytes = format!("{}\n", serde_json::to_string_pretty(&body).unwrap());
        sums.push_str(&format!("{:x}  {name}\n", Sha256::digest(bytes.as_bytes())));
        if update {
            std::fs::write(dir.join(name), &bytes).unwrap();
        }
        assert_eq!(
            std::fs::read_to_string(dir.join(name)).unwrap(),
            bytes,
            "{name}"
        );
    }
    if update {
        std::fs::write(dir.join("SHA256SUMS"), &sums).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(dir.join("SHA256SUMS")).unwrap(),
        sums
    );
}

#[test]
fn user_commands_preview_cost_2000_and_5000_entries() {
    for count in [2000, 5000] {
        let dir = tempfile::tempdir().unwrap();
        let (mut session, settings) = super::head_bytes_tests::head(dir.path());
        let (view, _) = session.build(&settings, None, false, None);
        session.accept(view.unwrap());
        session.index = Index::default();
        session.queued.clear();
        session.index.extend((1..=count).map(|i| {
            if i % 5 == 0 {
                text(i, &format!("m{i}"))
            } else {
                Entry::new(
                    i,
                    format!("m{i}"),
                    Role::Assistant,
                    i,
                    vec![output_part("p", i)],
                )
            }
        }));
        for i in 30..50 {
            session.queued.insert((format!("m{i}"), "p".into()));
        }
        // Setup and notices materialize the app projection before a command
        // can see this index. Include that preparation, outside preview time.
        session.app_update();
        let now = std::time::Instant::now();
        let p = session.command_preview(&settings, "flush");
        let elapsed = now.elapsed();
        assert!(p.available, "{p:?}");
        println!(
            "flush preview: {count} entries, {} queued, {:.3} ms",
            session.queued.len(),
            elapsed.as_secs_f64() * 1000.0
        );
    }
}

#[tokio::test]
async fn user_commands_worker_handles_managed_and_unknown_session_status() {
    let (session, client, route, setup, settings) = fixture();
    *client.entries.lock().unwrap() = vec![text(1, "prompt")];
    let key = session.key.clone();
    let module = crate::module::Module::new(client, settings, None, None);
    module.setup(route, setup).unwrap();
    module.idle_foreground(&key).await.unwrap();
    let caller = subc_protocol::Principal::Reserved {
        module_id: "occipital".into(),
    };
    let request = preview_request(&session, "status");
    let body = serde_json::to_vec(&json!({"method":"commands.preview", "params":request})).unwrap();
    let reply = module.command_request(&caller, &body).await.unwrap();
    assert_eq!(reply["available"], true);
    let mut request = request;
    request.subject = wire::Subject::session(wire::SessionRef::new("test", "mock", "unknown"));
    let body = serde_json::to_vec(&json!({"method":"commands.preview", "params":request})).unwrap();
    assert_eq!(
        module.command_request(&caller, &body).await.unwrap()["reason"],
        "not_managed"
    );
}

#[tokio::test]
async fn user_commands_status_waits_and_project_memory_count_use_contract_units() {
    let (mut session, client, settings) = ready();
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap());
    db.with_connection(|conn| conn.execute(
        "INSERT INTO memories(level, owner_id, category, origin_category, content, status, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES ('project', 'project', 'swe:architecture', 'ARCHITECTURE', 'A memory', 'active', 'hash1', 1, 1, 1, 1)", [],
    )).unwrap();
    session.project = Some(Project {
        id: "project".into(),
        root: dir.path().to_string_lossy().into(),
    });
    session.db = Some(db);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    for code in ["account_limit_exhausted", "no_route:accounts_blocked"] {
        session.account_wait = Some(crate::summary::account_wait::Waiting::new(
            crate::summary::account_wait::AccountWait {
                code: code.into(),
                at_ms: now,
                until_ms: now + 60_000,
                send: crate::summary::account_wait::SendKind::TurnOne,
            },
            None,
        ));
        let p = preview(&mut session, &client, &settings, "status").await;
        assert_eq!(
            p.effect.as_deref(),
            Some(if code.starts_with("no_route") {
                "Summaries wait for a model route"
            } else {
                "Summaries wait for an account limit"
            })
        );
        let rows = p.table.unwrap().rows;
        let wait = rows.iter().find(|r| r.label == "Summary wait").unwrap();
        assert_eq!(wait.cells[0].unit.as_deref(), Some("duration"));
        assert!(wait.cells[0].value.unwrap() <= 60_000.0);
        assert_eq!(
            rows.iter().find(|r| r.label == "Summaries").unwrap().cells[0]
                .state
                .as_deref(),
            Some("paused")
        );
        assert_eq!(
            rows.iter()
                .find(|r| r.label == "Project memories")
                .unwrap()
                .cells[0]
                .value,
            Some(1.0)
        );
    }
}

#[tokio::test]
async fn user_commands_new_memory_alone_lands_in_m1_without_folding_m0() {
    let (mut session, client, settings) = ready();
    session.queued.clear();
    session.features.summarizer = true;
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap());
    session.db = Some(db.clone());
    session.project = Some(Project {
        id: "project".into(),
        root: dir.path().to_string_lossy().into(),
    });
    let ops = session.render_head(&settings);
    session.baseline = session.next_baseline.take();
    session.latest = Some(View::seal(
        1,
        ops.into_iter()
            .map(|op| cortexkit_role_compaction::view::Edit::new(1, op))
            .collect(),
    ));
    session.version = 1;
    let baseline = session.baseline.clone().unwrap();
    db.with_connection(|conn| conn.execute(
        "INSERT INTO memories(level, owner_id, category, origin_category, content, status, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES ('project', 'project', 'swe:architecture', 'ARCHITECTURE', 'A newly published memory', 'active', 'hash1', 1, 1, 1, 1)", [],
    )).unwrap();
    let p = preview(&mut session, &client, &settings, "flush").await;
    assert!(p.available, "{p:?}");
    let request =
        wire::ModuleRunRequest::new(preview_request(&session, "flush"), p.version, "memory");
    assert_eq!(
        session
            .command_run(&client, &settings, &request)
            .await
            .unwrap()
            .outcome,
        "scheduled"
    );
    assert_eq!(baseline.m0, session.baseline.as_ref().unwrap().m0);
    assert!(session.latest.as_ref().unwrap().edits.iter().any(|edit| {
        matches!(&edit.op, EditOp::Insert { message, .. } if message.id == head::M1_ID && message.texts.iter().any(|t| t.contains("A newly published memory")))
    }));
}

#[tokio::test]
async fn user_commands_published_summary_lands_with_drops_without_pressure_refold() {
    let dir = tempfile::tempdir().unwrap();
    let (mut session, mut settings) = super::head_bytes_tests::head(dir.path());
    let (view, _) = session.build(&settings, None, false, None);
    session.accept(view.unwrap());
    let m0 = session.baseline.as_ref().unwrap().m0.clone();
    super::head_bytes_tests::add_summary(&session, 4, &"Published summary detail ".repeat(100));
    session.load_summaries();
    session.summary_unshown = true;
    session.queued.insert(("m20".into(), "p".into()));
    settings.history_budget_percentage = 1.0;
    let client = Client::default();
    let p = preview(&mut session, &client, &settings, "flush").await;
    assert!(p.available, "{p:?}");
    assert_eq!(p.facts.as_ref().unwrap()[0].data.value, Some(1.0));
    let request =
        wire::ModuleRunRequest::new(preview_request(&session, "flush"), p.version, "summary");
    assert_eq!(
        session
            .command_run(&client, &settings, &request)
            .await
            .unwrap()
            .outcome,
        "scheduled"
    );
    assert_eq!(m0, session.baseline.as_ref().unwrap().m0);
    assert!(!session.summary_unshown);
    assert!(session
        .latest
        .as_ref()
        .unwrap()
        .edits
        .iter()
        .any(|e| matches!(&e.op, EditOp::Cut { through } if through == "m16")));
}

#[tokio::test]
async fn user_commands_flush_rides_cleanup_and_reasoning_below_execute_threshold() {
    let (mut session, client, _, _, mut settings) = fixture();
    two_old_outputs(&mut session);
    let reasoning: Part = serde_json::from_value(json!({
        "id":"r", "kind":"reasoning", "text_bytes":8000, "digest":""
    }))
    .unwrap();
    let mut newest_reasoning = reasoning.clone();
    newest_reasoning.id = "new-r".into();
    session.index.extend(vec![
        Entry::new(5, "reasoning", Role::Assistant, 5, vec![reasoning]),
        Entry::new(
            6,
            "newest reasoning",
            Role::Assistant,
            6,
            vec![newest_reasoning],
        ),
        text(7, "latest prompt"),
    ]);
    session.queued.insert(("task".into(), "p".into()));
    session.conditions.last_prompt_tokens = Some(30_000);
    settings.keep_reasoning_tokens = 0;
    let p = preview(&mut session, &client, &settings, "flush").await;
    assert!(p.available, "{p:?}");
    assert!(p.facts.as_ref().unwrap()[2].data.value.unwrap() >= 2000.0);
    let request =
        wire::ModuleRunRequest::new(preview_request(&session, "flush"), p.version, "cleanup");
    assert_eq!(
        session
            .command_run(&client, &settings, &request)
            .await
            .unwrap()
            .outcome,
        "scheduled"
    );
    let view = session.latest.as_ref().unwrap();
    assert!(view.edits.iter().any(|e| matches!(&e.op, EditOp::Drop { mid, part: Some(part) } if mid == "reasoning" && part == "r")));
    assert!(view.edits.iter().any(
        |e| matches!(&e.op, EditOp::Replace { mid, field, .. } if mid == "old" && field == "output")
    ));
}

#[tokio::test]
async fn user_commands_failed_save_never_pushes_and_saved_push_failure_stays_rolled_back() {
    for failed_save in [true, false] {
        let (mut session, client, settings) = ready();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mode3.db");
        let store = Arc::new(crate::store::Store::open(&path).unwrap());
        session.set_store(Some(store.clone()));
        if failed_save {
            rusqlite::Connection::open(&path)
                .unwrap()
                .execute("DROP TABLE sessions", [])
                .unwrap();
        } else {
            *client.fail_apply.lock().unwrap() = true;
        }
        let p = preview(&mut session, &client, &settings, "flush").await;
        let request = wire::ModuleRunRequest::new(
            preview_request(&session, "flush"),
            p.version,
            "save-failure",
        );
        let result = session.command_run(&client, &settings, &request).await;
        if failed_save {
            assert_eq!(result.unwrap_err().code, "unavailable");
        } else {
            assert_eq!(result.unwrap().outcome, "failed");
        }
        assert!(session.latest.is_none());
        assert!(session.unconfirmed.is_empty());
        assert!(session.queued.contains(&("old".into(), "p".into())));
        if failed_save {
            assert!(client.offered.lock().unwrap().is_empty());
        } else {
            let restored = store.load(&session.key).unwrap();
            assert!(restored.unconfirmed.is_empty());
            let (mut resumed, _, _, _, _) = fixture();
            resumed.restore(restored);
            assert!(resumed.latest.is_none());
        }
    }
}

#[tokio::test]
async fn user_commands_worker_serializes_concurrent_replays() {
    let (mut session, client, route, mut setup, settings) = fixture();
    setup.newest = Some(cursor(&text(3, "new")));
    *client.entries.lock().unwrap() = vec![text(1, "task"), text(2, "old"), text(3, "new")];
    let module = crate::module::Module::new(client, settings, None, None);
    module.setup(route.clone(), setup).unwrap();
    module.idle_foreground(&route.session).await.unwrap();
    module
        .tool(&route, "ctx_reduce", json!({"drop":"2"}))
        .await
        .unwrap();
    session.key = route.session.clone();
    let caller = subc_protocol::Principal::Reserved {
        module_id: "occipital".into(),
    };
    let preview = preview_request(&session, "flush");
    let body = serde_json::to_vec(&json!({"method":"commands.preview", "params":preview})).unwrap();
    let p: wire::Preview =
        serde_json::from_value(module.command_request(&caller, &body).await.unwrap()).unwrap();
    assert!(p.available, "{p:?}");
    let request = wire::ModuleRunRequest::new(preview, p.version, "concurrent");
    let body = serde_json::to_vec(&json!({"method":"commands.run", "params":request})).unwrap();
    let (first, retry) = tokio::join!(
        module.command_request(&caller, &body),
        module.command_request(&caller, &body)
    );
    let first = first.unwrap();
    assert_eq!(first["outcome"], "scheduled");
    assert_eq!(first, retry.unwrap());
    let body = serde_json::to_vec(
        &json!({"method":"commands.preview", "params":preview_request(&session, "status")}),
    )
    .unwrap();
    let status = module.command_request(&caller, &body).await.unwrap();
    assert_eq!(status["facts"][2]["value"], 0.0);
}

#[tokio::test]
async fn user_commands_removal_facts_do_not_subtract_new_delta_tokens() {
    let (mut session, client, mut settings) = ready();
    let mut old = text(1, "old");
    old.parts[0] = Part::new(
        "p",
        PartBody::Text {
            text: "old content ".repeat(4).into(),
        },
    );
    old.parts[0].tag = Some(1);
    session.index = Index::default();
    session.index.extend(vec![old, text(2, "new prompt")]);
    settings.memory_budget_tokens = 20_000;
    session.features.summarizer = true;
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap());
    session.db = Some(db.clone());
    session.project = Some(Project {
        id: "project".into(),
        root: dir.path().to_string_lossy().into(),
    });
    let ops = session.render_head(&settings);
    session.baseline = session.next_baseline.take();
    session.latest = Some(View::seal(
        1,
        ops.into_iter()
            .map(|op| cortexkit_role_compaction::view::Edit::new(1, op))
            .collect(),
    ));
    session.version = 1;
    db.with_connection(|conn| conn.execute(
        "INSERT INTO memories(level, owner_id, category, origin_category, content, status, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES ('project', 'project', 'swe:architecture', 'ARCHITECTURE', ?1, 'active', 'hash1', 1, 1, 1, 1)",
        ["A memory detail. ".repeat(500)],
    )).unwrap();
    let p = preview(&mut session, &client, &settings, "flush").await;
    assert!(p.available);
    assert_eq!(p.facts.as_ref().unwrap()[1].data.value, Some(6.0));
    assert_eq!(p.facts.as_ref().unwrap()[2].data.value, Some(0.0));
    assert!(p.figure.as_ref().unwrap().value > p.figure.as_ref().unwrap().was.unwrap());
    let request =
        wire::ModuleRunRequest::new(preview_request(&session, "flush"), p.version, "net-growth");
    let reply = session
        .command_run(&client, &settings, &request)
        .await
        .unwrap();
    assert_eq!(reply.outcome, "scheduled");
    assert_eq!(reply.facts.as_ref().unwrap()[1].data.value, Some(6.0));
    assert!(reply.facts.as_ref().unwrap()[2].data.value.unwrap() > 10_000.0);
}
