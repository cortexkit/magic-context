use std::fs;
use std::process::Command;

use cortexkit_role_llm_runner::usage::RunUsage;
use rusqlite::params;

use super::*;
use crate::context_db::ContextDb;
use crate::dreamer::run::tests::{Client, Ends};

const SYSTEM: &str = include_str!("fixtures/PERSONA.md");
const MESSAGE: &str = include_str!("fixtures/first-message.md");

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    live: PathBuf,
    frozen: PathBuf,
    persona: PathBuf,
    checkout: PathBuf,
    out: PathBuf,
    spec: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("lab-root");
        let persona = root.join("persona");
        let checkout = root.join("0.50");
        let out = root.join("out");
        let spec = root.join("spec.json");
        let live = temp.path().join("live-context.db");
        let frozen = temp.path().join("frozen ?#%.db");
        fs::create_dir_all(&persona).unwrap();
        fs::create_dir_all(&checkout).unwrap();
        fs::write(persona.join("PERSONA.md"), SYSTEM).unwrap();
        fs::write(persona.join("first-message.md"), MESSAGE).unwrap();
        fs::write(root.join("context.md"), "A fixed context note.").unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&checkout)
            .status()
            .unwrap()
            .success());
        let db = ContextDb::create_for_tests(&live).unwrap();
        db.with_connection(|conn| {
            for (id, owner, writer, text) in [
                (7, "p", "historian", "Invariant sharedterm from the frozen fixture."),
                (2, "p", "agent", "Second memory from the frozen fixture."),
                (9, "secret", "agent", "sharedterm from a different project memory."),
            ] {
                conn.execute(
                    "INSERT INTO memories (id, level, owner_id, category, origin_category, content,
                        normalized_hash, first_seen_at, created_at, updated_at, last_seen_at, source_type, importance, verified_at)
                     VALUES (?1, 'project', ?2, 'swe:architecture', 'ARCHITECTURE', ?3, ?3, 1, 1000, 1, 1, ?4, 72, 2000)",
                    params![id, owner, text, writer])?;
            }
            conn.execute("INSERT INTO memory_verifications (memory_id, file_path, verified_at) VALUES (7, 'src/example.rs', 2000)", [])?;
            for (session, project, text) in [
                ("session-p", "p", "sharedterm in the indexed project message."),
                ("session-p2", "p", "sharedterm in the other project session."),
                ("unrelated", "secret", "sharedterm in the different project message."),
            ] {
                conn.execute("INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?1, 'mock', ?2, 1)", params![session, project])?;
                conn.execute("INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content)
                        VALUES (?1, 12, ?1, 'user', ?2)", params![session, text])?;
                conn.execute("INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms)
                        VALUES (?1, 12, ?2, 1000)", params![session, conn.last_insert_rowid()])?;
                conn.execute("INSERT INTO compartments (session_id, harness, sequence, start_message, end_message, title, content, created_at)
                        VALUES (?1, 'mock', 1, 1, 4, 'A frozen summary', ?2, 2000)", params![session, format!("sharedterm in the summary for {session}.")])?;
            }
            Ok::<(), rusqlite::Error>(())
        }).unwrap();
        drop(db);
        fs::copy(&live, &frozen).unwrap();
        Self {
            _temp: temp,
            root,
            live,
            frozen,
            persona,
            checkout,
            out,
            spec,
        }
    }

    fn spec_value(&self) -> Value {
        json!({"project":"p","root":self.root,"store":self.frozen,"checkouts":{"0.50":self.checkout},
            "memory_ids":[7,2],"persona_dir":self.persona,"context_files":[{"title":"Context note","path":self.root.join("context.md")}],
            "tools":["submit","git_read","memory_search"],"step_cap":12,"out_dir":self.out,"route":{"iq":64,"eq":29}})
    }

    async fn start(&self, value: &Value) -> Result<Start, String> {
        fs::write(&self.spec, serde_json::to_vec(value).unwrap()).unwrap();
        Start::load(&self.spec, &self.live, Arc::new(Registry::default())).await
    }

    async fn run(&self, value: Value, ends: Ends) -> Arc<Client> {
        let registry = Arc::new(Registry::default());
        let mut client = Client::new(&["p/a"], &[ends]);
        client.plans = vec!["ra"];
        client.catalog = Ok(vec![("read", &["code.read/v1"]), ("aft_search", &[])]);
        client.lab = Some(registry.clone());
        client.lab_verdicts_path = Some(self.out.join("verdicts.json"));
        let client = Arc::new(client);
        self.start(&value)
            .await
            .unwrap()
            .execute(client.clone(), registry, None)
            .await;
        client
    }

    fn output(&self, name: &str) -> Value {
        serde_json::from_slice(&fs::read(self.out.join(name)).unwrap()).unwrap()
    }
}

fn submit(entries: &[Value]) -> Value {
    json!({"name":"submit","arguments":{"verdicts":entries}})
}

fn verdict(id: i64, note: &str) -> Value {
    json!({"id":id,"verdict":"keep","life":"long","proof":"none","evidence":[],"note":note})
}

#[tokio::test]
async fn scripted_lab_records_incremental_verdicts_and_request_without_store_writes() {
    let fixture = Fixture::new();
    let live_before = fs::read(&fixture.live).unwrap();
    let frozen_before = fs::read(&fixture.frozen).unwrap();
    let mut spec = fixture.spec_value();
    spec["tools"].as_array_mut().unwrap().push(json!("reader"));
    let client = fixture
        .run(
            spec,
            Ends::LabTools(vec![
                submit(&[verdict(2, "first result")]),
                submit(&[verdict(2, "must not apply"), verdict(7000, "unknown id")]),
                submit(&[verdict(7, "other result"), verdict(2, "replacement")]),
            ]),
        )
        .await;
    let answer = fixture.output("verdicts.json");
    assert_eq!(
        answer,
        json!([verdict(7, "other result"), verdict(2, "replacement")])
    );
    let calls = client.lab_tool_results.lock().unwrap();
    assert!(calls[0]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("1 of 2 still open; missing ids: 7"));
    assert_eq!(calls[1]["isError"], true);
    assert!(calls[1]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("unknown memory id 7000"));
    assert!(calls[2]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("0 of 2 still open"));
    let run = fixture.output("run.json");
    assert_eq!(run["ended"], "complete");
    assert_eq!(run["missing_ids"], json!([]));
    assert_eq!(run["model"]["model"], "a");
    assert_eq!(run["route"], "p/a");
    assert_eq!(run["child_session_id"], client.children()[0]);
    assert_eq!(run["steps"], 4);
    assert_eq!(
        run["usage"]["total"],
        json!({"new_input":140,"cached_input":321,"output":42})
    );
    assert_eq!(run["usage"]["per_step"], Value::Null);
    assert!(run["usage"]["per_step_unavailable"].is_string());
    assert!(run["wall_time_ms"].is_number());
    let request = fixture.output("request.json");
    let sends = client.sends.lock().unwrap();
    assert_eq!(sends.len(), 1);
    let (child, sent) = &sends[0];
    assert_eq!(child.project_root.as_deref(), fixture.root.to_str());
    assert_eq!(request["first_message"].as_str(), sent.prompt.as_deref());
    assert_eq!(
        request["system_text"],
        sent.plan.as_ref().unwrap()["system_text_items"][0]["params"]
            [crate::catalog::DREAMER_TEXT_PARAM]
    );
    assert_eq!(sent.runner_params["stop_when"]["max_steps"], 12);
    assert_eq!(
        request["reader_tools_at_preflight"]
            .as_array()
            .unwrap()
            .iter()
            .chain(request["lab_tools"].as_array().unwrap())
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["read", "aft_search", "git_read", "memory_search", "submit"]
    );
    let first = request["first_message"].as_str().unwrap();
    assert!(first.contains("## Context note\n\nA fixed context note."));
    assert!(first.contains("Writer: summarizer\nImportance: 72\nLast confirmed: 1970-01-01T00:00:02+00:00\nLinked files: src/example.rs"));
    assert!(first.find("Memory 7").unwrap() < first.find("Memory 2").unwrap());
    assert!(request["system_text"]
        .as_str()
        .unwrap()
        .contains("Git is available."));
    assert!(request["system_text"]
        .as_str()
        .unwrap()
        .contains("Reader is available."));
    assert_eq!(client.selects.lock().unwrap()[0].requirements.eq, Some(29));
    assert_eq!(live_before, fs::read(&fixture.live).unwrap());
    assert_eq!(frozen_before, fs::read(&fixture.frozen).unwrap());
}

#[tokio::test]
async fn incomplete_lab_keeps_accepted_calls_and_lists_missing_ids() {
    let fixture = Fixture::new();
    let mut spec = fixture.spec_value();
    spec["tools"] = json!(["submit"]);
    spec["route"] = json!("p/a");
    let client = fixture
        .run(
            spec,
            Ends::LabTools(vec![
                submit(&[verdict(2, "only accepted answer")]),
                submit(&[
                    verdict(7, "would complete the run"),
                    verdict(100, "invalid id"),
                ]),
            ]),
        )
        .await;
    assert_eq!(
        client.selects.lock().unwrap()[0].pin.as_deref(),
        Some("p/a")
    );
    assert_eq!(
        fixture.output("verdicts.json"),
        json!([verdict(2, "only accepted answer")])
    );
    let run = fixture.output("run.json");
    assert_eq!(run["ended"], "incomplete");
    assert_eq!(run["missing_ids"], json!([7]));
    let request = fixture.output("request.json");
    assert_eq!(request["system_text"], "Test lab persona.");
    assert!(!request["first_message"]
        .as_str()
        .unwrap()
        .contains("Git is available."));
}

#[tokio::test]
async fn undefined_persona_name_refuses_before_sending_to_model() {
    let fixture = Fixture::new();
    fs::write(
        fixture.persona.join("PERSONA.md"),
        format!("{SYSTEM}\n{{{{ unknown_name }}}}"),
    )
    .unwrap();
    let client = fixture
        .run(fixture.spec_value(), Ends::Reply("would be a model call"))
        .await;
    assert!(client.sends.lock().unwrap().is_empty());
    let run = fixture.output("run.json");
    assert_eq!(run["ended"], "incomplete");
    assert_eq!(run["stop"], "refusal");
    assert!(run["error"].as_str().unwrap().contains("undefined"));
    assert!(!fixture.out.join("request.json").exists());
}

#[tokio::test]
async fn frozen_search_uses_only_project_sessions_and_indexed_messages() {
    let fixture = Fixture::new();
    let start = fixture.start(&fixture.spec_value()).await.unwrap();
    let lab = Arc::new(Lab::load(start, None).unwrap());
    let answer = lab
        .clone()
        .tool("memory_search", json!({"query":"sharedterm"}))
        .await
        .unwrap();
    assert!(answer.contains("id=7"), "{answer}");
    assert!(
        answer.contains("session=session-p ref=session-p:12"),
        "{answer}"
    );
    assert!(
        answer.contains("session=session-p2 ref=session-p2:1-4"),
        "{answer}"
    );
    assert!(
        answer.contains("date=1970-01-01T00:00:01+00:00"),
        "{answer}"
    );
    assert!(
        !answer.contains("unrelated") && !answer.contains("different project"),
        "{answer}"
    );
    let db = lab.store.lock().unwrap();
    assert!(db
        .execute("UPDATE memories SET retrieval_count=1", [])
        .unwrap_err()
        .to_string()
        .contains("readonly"));
    assert_eq!(
        db.query_row(
            "SELECT retrieval_count FROM memories WHERE id=7",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let history = crate::search::lab::History::load(&db, "p", Some(&["session-p".into()])).unwrap();
    let narrow = history
        .search(
            &db,
            "p",
            &json!({"query":"sharedterm","sources":["message"]}),
            None,
        )
        .unwrap();
    assert!(narrow.contains("session=session-p ref=session-p:12"));
    assert!(!narrow.contains("session-p2"));
    assert!(crate::search::lab::History::load(&db, "p", Some(&["unrelated".into()])).is_err());
}

#[tokio::test]
async fn git_read_refuses_escape_option_ref_sixth_subcommand_and_write_option() {
    let fixture = Fixture::new();
    let cases = [
        (
            json!({"checkout":"0.50","command":"log","paths":["../context.md"]}),
            "inside the checkout",
        ),
        (
            json!({"checkout":"0.50","command":"log","refs":["--output=other"]}),
            "not a local commit ref",
        ),
        (
            json!({"checkout":"0.50","command":"status"}),
            "does not allow the",
        ),
        (
            json!({"checkout":"0.50","command":"diff","refs":["HEAD","HEAD"],"options":["--output=other"]}),
            "does not allow option",
        ),
    ];
    for (input, reason) in cases {
        let request: git::Request = serde_json::from_value(input).unwrap();
        let error = request.read(&fixture.checkout).await.unwrap_err();
        assert!(error.contains(reason), "{error}");
    }
}

#[tokio::test]
async fn spec_refuses_live_path_hardlink_and_checkout_escape() {
    let fixture = Fixture::new();
    let mut spec = fixture.spec_value();
    spec["store"] = json!(fixture.live);
    assert!(fixture
        .start(&spec)
        .await
        .err()
        .unwrap()
        .contains("live context.db"));
    #[cfg(unix)]
    {
        let link = fixture.root.join("hardlink.sqlite");
        fs::hard_link(&fixture.live, &link).unwrap();
        spec["store"] = json!(link);
        assert!(fixture
            .start(&spec)
            .await
            .err()
            .unwrap()
            .contains("live context.db"));
        let link = fixture.root.join("link");
        std::os::unix::fs::symlink(&fixture.checkout, &link).unwrap();
        spec["store"] = json!(fixture.frozen);
        spec["checkouts"]["0.50"] = json!(link);
        assert!(fixture
            .start(&spec)
            .await
            .err()
            .unwrap()
            .contains("must not be a symlink"));
    }
    let mut spec = fixture.spec_value();
    spec["out_dir"] = json!(fixture.checkout.join("out"));
    assert!(fixture
        .start(&spec)
        .await
        .err()
        .unwrap()
        .contains("inside a checkout"));
}

fn review_client(registry: &Arc<Registry>, ends: &[Ends]) -> Client {
    let mut client = Client::new(&["p/a", "p/b"], ends);
    client.plans = vec!["ra", "rb"];
    client.lab = Some(registry.clone());
    client
}

#[tokio::test]
async fn lab_review_only_mapped_harness_contributes_history_for_shared_ids() {
    let fixture = Fixture::new();
    let conn = rusqlite::Connection::open(&fixture.frozen).unwrap();
    conn.execute("INSERT INTO compartments (session_id, harness, sequence, start_message, end_message, title, content, created_at)
        VALUES ('session-p', 'unknown', 2, 3, 5, 'private sharedterm', 'not mapped in this project', 2000)", []).unwrap();
    conn.execute("UPDATE compartments SET harness='mock' WHERE session_id IN ('session-p','session-p2') AND sequence=1", []).unwrap();
    drop(conn);
    let start = fixture.start(&fixture.spec_value()).await.unwrap();
    let lab = Arc::new(Lab::load(start, None).unwrap());
    let answer = lab
        .tool(
            "memory_search",
            json!({"query":"sharedterm", "sources":["message"]}),
        )
        .await
        .unwrap();
    assert!(answer.contains("ref=session-p:1-4"), "{answer}");
    assert!(!answer.contains("private sharedterm"), "{answer}");
    assert!(!answer.contains("ref=session-p:12"), "{answer}");
    assert!(answer.contains("ref=session-p2:12"), "{answer}");
    assert_eq!(
        answer.matches("1 sessions skipped: ambiguous id").count(),
        1,
        "{answer}"
    );
}

#[tokio::test]
async fn lab_review_deadline_bounds_a_stalled_route_selection() {
    let fixture = Fixture::new();
    let mut spec = fixture.spec_value();
    spec["deadline_minutes"] = json!(1);
    let start = fixture.start(&spec).await.unwrap();
    let registry = Arc::new(Registry::default());
    let mut client = review_client(&registry, &[Ends::Reply("must not be sent")]);
    client.lab_select_delay = Some(std::time::Duration::from_secs(61));
    let client = Arc::new(client);
    tokio::time::pause();
    start.execute(client.clone(), registry, None).await;
    assert!(client.sends.lock().unwrap().is_empty());
    let result = fixture.output("run.json");
    assert_eq!(result["stop"], "deadline");
    assert_eq!(result["ended"], "incomplete");
}

#[tokio::test]
async fn lab_review_account_limit_after_submit_never_starts_a_second_child() {
    use cortexkit_role_llm_runner::run::{states, RunError, RunResult};
    let fixture = Fixture::new();
    let registry = Arc::new(Registry::default());
    let mut client = review_client(
        &registry,
        &[
            Ends::LabTools(vec![submit(&[verdict(7, "saved")])]),
            Ends::Reply("must not run"),
        ],
    );
    let mut run = RunResult::new("run", states::ERROR);
    let error = RunError::new(
        "transient",
        "quota exhausted",
        cortexkit_role_llm_runner::errors::ACCOUNT_LIMIT_EXHAUSTED,
    )
    .with_resets_at_ms((crate::memory_writes::now_ms() + 3_600_000) as u64);
    run.awaits = Some(cortexkit_role_llm_runner::errors::ending_awaits(
        &error,
        crate::memory_writes::now_ms() as u64,
    ));
    run.error = Some(error);
    client.lab_result = Some(run);
    client
        .route_script
        .lock()
        .unwrap()
        .extend([Ok("p/a"), Ok("p/b")]);
    let client = Arc::new(client);
    fixture
        .start(&fixture.spec_value())
        .await
        .unwrap()
        .execute(client.clone(), registry, None)
        .await;
    let result = fixture.output("run.json");
    assert_eq!(client.children().len(), 1, "{result}");
    assert_eq!(result["stop"], "account_limit");
    assert_eq!(result["account_limit_detail"], "child_had_tool_calls");
    assert_eq!(result["child_session_id"], client.children()[0]);
    assert_eq!(
        fixture.output("verdicts.json"),
        json!([verdict(7, "saved")])
    );
}

#[tokio::test]
async fn lab_review_artifacts_distinguish_exact_text_preflight_tools_and_receipt() {
    let fixture = Fixture::new();
    let mut spec = fixture.spec_value();
    spec["tools"] = json!(["reader", "submit"]);
    let client = fixture.run(spec, Ends::Reply("")).await;
    let request = fixture.output("request.json");
    assert!(request["system_text"].is_string(), "{request}");
    assert_eq!(
        request["first_message"].as_str(),
        client.sends.lock().unwrap()[0].1.prompt.as_deref()
    );
    assert_eq!(request["lab_tools"][0]["name"], "submit");
    assert_eq!(request["reader_tools_at_preflight"][0]["name"], "read");
    let result = fixture.output("run.json");
    assert_eq!(result["sent"], true);
    assert!(result["request_written_at"].is_number(), "{result}");
}

#[tokio::test]
async fn lab_review_complete_verdicts_remain_complete_at_step_cap() {
    let fixture = Fixture::new();
    let registry = Arc::new(Registry::default());
    let mut client = review_client(
        &registry,
        &[Ends::LabTools(vec![submit(&[
            verdict(7, "one"),
            verdict(2, "two"),
        ])])],
    );
    client.lab_result = Some(cortexkit_role_llm_runner::run::RunResult::new(
        "run",
        cortexkit_role_llm_runner::run::states::MAX_STEPS,
    ));
    fixture
        .start(&fixture.spec_value())
        .await
        .unwrap()
        .execute(Arc::new(client), registry, None)
        .await;
    let result = fixture.output("run.json");
    assert_eq!(result["ended"], "complete");
    assert_eq!(result["stop"], "step_cap");
}

#[tokio::test]
async fn lab_review_usage_reports_known_missing_steps() {
    use cortexkit_role_llm_runner::run::{states, RunResult};
    let fixture = Fixture::new();
    let registry = Arc::new(Registry::default());
    let mut client = review_client(&registry, &[Ends::LabTools(vec![])]);
    let mut result = RunResult::new("run", states::COMPLETED);
    let mut usage = RunUsage::default();
    usage.steps = 2;
    usage.unreported_steps = 1;
    usage.output_tokens = Some(60);
    result.usage = Some(usage);
    client.lab_result = Some(result);
    fixture
        .start(&fixture.spec_value())
        .await
        .unwrap()
        .execute(Arc::new(client), registry, None)
        .await;
    let result = fixture.output("run.json");
    assert_eq!(result["usage"]["unreported_steps"], 1);
    assert_eq!(result["usage"]["usage_complete"], false);
    assert_eq!(result["usage"]["total"]["output"], 60);
}

#[tokio::test]
async fn lab_review_merge_requires_an_active_project_destination_outside_or_inside_sample() {
    let fixture = Fixture::new();
    let conn = rusqlite::Connection::open(&fixture.frozen).unwrap();
    for (id, status) in [(50, "active"), (51, "inactive")] {
        conn.execute("INSERT INTO memories (id,level,owner_id,category,origin_category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at,status)
           VALUES (?1,'project','p','swe:architecture','ARCHITECTURE',?1,?1,1,1,1,1,?2)", params![id,status]).unwrap();
    }
    drop(conn);
    let merge = |into| json!({"id":7,"verdict":"merge","into":into,"new_text":"updated","life":"long","proof":"none","evidence":[],"note":"merge test"});
    let client = fixture
        .run(
            fixture.spec_value(),
            Ends::LabTools(vec![
                submit(&[merge(90)]),
                submit(&[merge(9)]),
                submit(&[merge(51)]),
                submit(&[merge(50)]),
            ]),
        )
        .await;
    let results = client.lab_tool_results.lock().unwrap();
    for answer in &results[..3] {
        assert_eq!(answer["isError"], true, "{answer}");
    }
    assert_ne!(results[3]["isError"], true);
    assert_eq!(fixture.output("verdicts.json"), json!([merge(50)]));
}

#[tokio::test]
async fn lab_review_invalid_submit_changes_no_entries_on_disk() {
    let fixture = Fixture::new();
    let client = fixture
        .run(
            fixture.spec_value(),
            Ends::LabTools(vec![
                submit(&[verdict(2, "prior")]),
                submit(&[verdict(7, "must not apply"), verdict(777, "unknown")]),
                submit(&[verdict(2, "only id touched later")]),
            ]),
        )
        .await;
    let observed = client.lab_verdicts_after.lock().unwrap();
    assert_eq!(observed[1], json!([verdict(2, "prior")]));
    assert_eq!(
        fixture.output("verdicts.json"),
        json!([verdict(2, "only id touched later")])
    );
}

#[tokio::test]
async fn lab_review_undefined_first_message_name_is_checked_in_an_unrendered_branch() {
    let fixture = Fixture::new();
    fs::write(
        fixture.persona.join("first-message.md"),
        format!("{MESSAGE}\n{{% if false %}}{{{{ undefined_first_message }}}}{{% endif %}}"),
    )
    .unwrap();
    let client = fixture
        .run(fixture.spec_value(), Ends::Reply("would be a model call"))
        .await;
    assert!(client.children().is_empty());
    assert!(fixture.output("run.json")["error"]
        .as_str()
        .unwrap()
        .contains("undefined_first_message"));
}

#[tokio::test]
async fn lab_review_validation_times_out_while_blocking_work_is_still_stalled() {
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        validate_with_limit(Duration::from_millis(20), move |_| {
            let _ = wait.recv_timeout(Duration::from_secs(2));
            Ok(())
        }),
    )
    .await;
    drop(release);
    assert_eq!(result.unwrap(), Err(VALIDATION_TIMEOUT.into()));
}

#[tokio::test]
async fn lab_review_second_start_reports_active_output_before_reserving() {
    let fixture = Fixture::new();
    let registry = Arc::new(Registry::default());
    let mut spec = fixture.spec_value();
    fs::write(&fixture.spec, serde_json::to_vec(&spec).unwrap()).unwrap();
    let first = Start::load(&fixture.spec, &fixture.live, registry.clone())
        .await
        .unwrap();
    let second = fixture.root.join("second");
    spec["out_dir"] = json!(second);
    fs::write(&fixture.spec, serde_json::to_vec(&spec).unwrap()).unwrap();
    let error = Start::load(&fixture.spec, &fixture.live, registry.clone())
        .await
        .err()
        .unwrap();
    assert!(error.contains(fixture.out.to_str().unwrap()), "{error}");
    assert!(!second.exists());
    drop(first);
    assert!(Start::load(&fixture.spec, &fixture.live, registry)
        .await
        .is_ok());
}

fn lab_account_result(usage: Option<RunUsage>) -> cortexkit_role_llm_runner::run::RunResult {
    use cortexkit_role_llm_runner::run::{states, RunError, RunResult};
    let mut result = RunResult::new("run", states::ERROR);
    let error = RunError::new(
        "transient",
        "quota exhausted",
        cortexkit_role_llm_runner::errors::ACCOUNT_LIMIT_EXHAUSTED,
    )
    .with_resets_at_ms((crate::memory_writes::now_ms() + 3_600_000) as u64);
    result.awaits = Some(cortexkit_role_llm_runner::errors::ending_awaits(
        &error,
        crate::memory_writes::now_ms() as u64,
    ));
    result.error = Some(error);
    result.usage = usage;
    result
}

#[tokio::test]
async fn lab_review_accepted_account_refusal_without_usage_does_not_reselect() {
    let fixture = Fixture::new();
    let registry = Arc::new(Registry::default());
    let mut client = review_client(
        &registry,
        &[Ends::LabTools(vec![]), Ends::Reply("must not run")],
    );
    client.lab_result = Some(lab_account_result(None));
    client
        .route_script
        .lock()
        .unwrap()
        .extend([Ok("p/a"), Ok("p/b")]);
    let client = Arc::new(client);
    fixture
        .start(&fixture.spec_value())
        .await
        .unwrap()
        .execute(client.clone(), registry, None)
        .await;
    let result = fixture.output("run.json");
    assert_eq!(client.children().len(), 1, "{result}");
    assert_eq!(result["account_limit_detail"], "accepted_usage_unknown");
    assert_eq!(result["sent"], true);
}

#[tokio::test]
async fn lab_review_explicit_zero_steps_can_reselect_and_publish_only_final_child() {
    let fixture = Fixture::new();
    let registry = Arc::new(Registry::default());
    let mut client = review_client(&registry, &[Ends::LabTools(vec![]), Ends::Reply("")]);
    client.lab_result = Some(lab_account_result(Some(RunUsage::default())));
    client
        .route_script
        .lock()
        .unwrap()
        .extend([Ok("p/a"), Ok("p/b")]);
    let client = Arc::new(client);
    fixture
        .start(&fixture.spec_value())
        .await
        .unwrap()
        .execute(client.clone(), registry, None)
        .await;
    let result = fixture.output("run.json");
    assert_eq!(client.children().len(), 2, "{result}");
    assert_eq!(result["account_limit_detail"], "zero_steps_reselected");
    assert_eq!(result["child_session_id"], client.children()[1]);
    assert_eq!(result["stop"], "model_finished");
    assert_eq!(result["sent"], true);
}

#[tokio::test]
async fn lab_review_pre_accept_refusal_has_no_send_receipt() {
    let fixture = Fixture::new();
    let registry = Arc::new(Registry::default());
    let client = review_client(&registry, &[]);
    client
        .send_errors
        .lock()
        .unwrap()
        .push_back(crate::client::ClientError::new("refused before acceptance"));
    let client = Arc::new(client);
    fixture
        .start(&fixture.spec_value())
        .await
        .unwrap()
        .execute(client.clone(), registry, None)
        .await;
    let result = fixture.output("run.json");
    assert_eq!(result["sent"], false);
    assert!(result["request_written_at"].is_number());
    assert_eq!(result["usage"]["usage_complete"], false);
}

#[tokio::test]
async fn lab_review_missing_terminal_usage_keeps_partial_totals_marked_incomplete() {
    use cortexkit_role_llm_runner::run::{states, RunResult};
    let fixture = Fixture::new();
    let registry = Arc::new(Registry::default());
    let mut client = review_client(&registry, &[Ends::LabTools(vec![]), Ends::Reply("")]);
    let mut active = RunResult::new("run", states::ACTIVE);
    let mut usage = RunUsage::default();
    usage.steps = 2;
    usage.output_tokens = Some(120);
    active.usage = Some(usage);
    client.lab_result = Some(active);
    fixture
        .start(&fixture.spec_value())
        .await
        .unwrap()
        .execute(Arc::new(client), registry, None)
        .await;
    let result = fixture.output("run.json");
    assert_eq!(result["usage"]["unreported_steps"], 0);
    assert_eq!(result["usage"]["usage_complete"], false);
    assert_eq!(result["usage"]["total"]["output"], 120);
}
