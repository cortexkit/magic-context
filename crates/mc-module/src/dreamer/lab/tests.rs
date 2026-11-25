use std::fs;
use std::process::Command;

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
                conn.execute("INSERT INTO compartments (session_id, sequence, start_message, end_message, title, content, created_at)
                        VALUES (?1, 1, 1, 4, 'A frozen summary', ?2, 2000)", params![session, format!("sharedterm in the summary for {session}.")])?;
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
        Start::load(&self.spec, &self.live).await
    }

    async fn run(&self, value: Value, ends: Ends) -> Arc<Client> {
        let registry = Arc::new(Registry::default());
        let mut client = Client::new(&["p/a"], &[ends]);
        client.plans = vec!["ra"];
        client.catalog = Ok(vec![("read", &["code.read/v1"]), ("aft_search", &[])]);
        client.lab = Some(registry.clone());
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
        request["system"],
        sent.plan.as_ref().unwrap()["system_text_items"][0]["params"]
            [crate::catalog::DREAMER_TEXT_PARAM]
    );
    assert_eq!(sent.runner_params["stop_when"]["max_steps"], 12);
    assert_eq!(
        request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["read", "aft_search", "git_read", "memory_search", "submit"]
    );
    let first = request["first_message"].as_str().unwrap();
    assert!(first.contains("## Context note\n\nA fixed context note."));
    assert!(first.contains("Writer: summarizer\nImportance: 72\nLast confirmed: 1970-01-01T00:00:02+00:00\nLinked files: src/example.rs"));
    assert!(first.find("Memory 7").unwrap() < first.find("Memory 2").unwrap());
    assert!(request["system"]
        .as_str()
        .unwrap()
        .contains("Git is available."));
    assert!(request["system"]
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
    assert_eq!(request["system"], "Test lab persona.");
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
    assert_eq!(run["ended"], "refusal");
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
