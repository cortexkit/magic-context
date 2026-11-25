use std::fs;
use std::process::Command;

use cortexkit_role_llm_runner::usage::RunUsage;
use cortexkit_role_tool_provider::catalog::{CatalogAnswer, CatalogTool};
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
        self.run_with(value, ends, |_| {}).await
    }

    async fn run_with(
        &self,
        value: Value,
        ends: Ends,
        configure: impl FnOnce(&mut Client),
    ) -> Arc<Client> {
        let registry = Arc::new(Registry::default());
        let mut client = Client::new(&["p/a"], &[ends]);
        client.plans = vec!["ra"];
        client.catalog = Ok(vec![("read", &["code.read/v1"]), ("aft_search", &[])]);
        client.lab = Some(registry.clone());
        client.lab_verdicts_path = Some(self.out.join("verdicts.json"));
        configure(&mut client);
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

    async fn search_lab(&self, sessions: Option<&[&str]>) -> Arc<Lab> {
        let mut spec = self.spec_value();
        spec["tools"] = json!(["memory_search", "history_search"]);
        spec["history_sessions"] = json!(sessions);
        Arc::new(Lab::load(self.start(&spec).await.unwrap(), None).unwrap())
    }
}

fn index_message(
    conn: &rusqlite::Connection,
    session: &str,
    n: i64,
    role: &str,
    text: &str,
    at: i64,
) {
    conn.execute(
        "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![session, n, format!("{session}-{n}"), role, text],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms)
         VALUES (?1, ?2, ?3, ?4)",
        params![session, n, conn.last_insert_rowid(), at],
    ).unwrap();
}

fn group<'a>(answer: &'a str, title: &str) -> &'a str {
    let heading = format!("## {title}\n");
    answer
        .split_once(&heading)
        .unwrap_or_else(|| panic!("missing group {title:?}: {answer}"))
        .1
        .split("\n\n## ")
        .next()
        .unwrap()
        .trim()
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
    spec["tools"]
        .as_array_mut()
        .unwrap()
        .extend([json!("reader"), json!("history_search")]);
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
        [
            "read",
            "aft_search",
            "git_read",
            "memory_search",
            "history_search",
            "submit"
        ]
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
    assert!(request["system_text"]
        .as_str()
        .unwrap()
        .contains("History search is available."));
    assert!(request["system_text"]
        .as_str()
        .unwrap()
        .contains("Memory search is available."));
    let lab_tools = request["lab_tools"].as_array().unwrap();
    let properties = |name: &str| {
        let mut keys = lab_tools.iter().find(|tool| tool["name"] == name).unwrap()["input_schema"]
            ["properties"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort_unstable();
        keys
    };
    assert_eq!(properties("memory_search"), ["limit", "query"]);
    assert_eq!(
        properties("history_search"),
        ["from", "include_agent", "limit", "query", "to"]
    );
    assert_eq!(client.selects.lock().unwrap()[0].requirements.eq, Some(29));
    assert_eq!(live_before, fs::read(&fixture.live).unwrap());
    assert_eq!(frozen_before, fs::read(&fixture.frozen).unwrap());
}

#[tokio::test]
async fn lab_without_sidekick_keeps_its_send_and_request_bytes() {
    use sha2::{Digest, Sha256};

    let fixture = Fixture::new();
    let mut spec = fixture.spec_value();
    spec["tools"].as_array_mut().unwrap().push(json!("reader"));
    let client = fixture.run(spec, Ends::LabTools(vec![])).await;
    let sends = client.sends.lock().unwrap();
    assert_eq!(sends.len(), 1);
    let mut sent = sends[0].1.clone();
    // The child ID includes a PID and wall clock; every other send byte is stable.
    assert_eq!(sent.send_id, sends[0].0.session.session);
    sent.send_id = "mc-dream:fixed:0.0".into();
    let send = serde_json::to_vec(&sent).unwrap();
    let request = fs::read(fixture.out.join("request.json")).unwrap();
    let pins = [
        format!("{:x}", Sha256::digest(&send)),
        format!("{:x}", Sha256::digest(&request)),
    ];
    assert_eq!(
        pins,
        [
            "b7094a89a773d890f4ef21f2a5175ccb2642986aa577b15c95555e0f3769fbe2",
            "a32d53392fd942f9ef6407e3a952f50a2c99a043dd8b92098b0640d805063c37",
        ]
    );
}

fn sidekick_catalog(presets: &[&str], tools: &[&str]) -> CatalogAnswer {
    let mut answer = CatalogAnswer::default();
    answer.presets = presets.iter().map(|name| (*name).into()).collect();
    answer.tools = tools
        .iter()
        .map(|name| {
            let mut tool = CatalogTool::default();
            tool.name = (*name).into();
            tool
        })
        .collect();
    answer
}

fn sidekick_provider(client: &mut Client, presets: &[&str], tools: &[&str]) {
    client.providers.push("prefrontal");
    client.lab_catalogs = Some(BTreeMap::from([
        (
            ("prefrontal", None),
            Ok(sidekick_catalog(presets, &["sidekick"])),
        ),
        (
            ("prefrontal", Some("sidekick")),
            Ok(sidekick_catalog(&[], tools)),
        ),
    ]));
}

fn available_sidekick(client: &mut Client) {
    sidekick_provider(client, &["worker", "sidekick"], &["sidekick"]);
}

#[tokio::test]
async fn sidekick_lab_uses_a_worker_scope_and_asks_aft_for_reader() {
    let fixture = Fixture::new();
    let mut spec = fixture.spec_value();
    spec["tools"] = json!(["reader", "sidekick"]);
    let worker = fixture
        .run_with(spec.clone(), Ends::LabTools(vec![]), available_sidekick)
        .await;
    assert_eq!(
        *worker.lab_send_projects.lock().unwrap(),
        [Some("p".to_owned())]
    );
    {
        let asked = worker.asked.lock().unwrap();
        let projects = worker.lab_catalog_projects.lock().unwrap();
        let scoped_catalogs: Vec<_> = asked
            .iter()
            .zip(projects.iter())
            .filter_map(|(request, project)| {
                project.as_ref().map(|project| {
                    assert_eq!(project, "p");
                    (request.0.as_str(), request.1.as_deref())
                })
            })
            .collect();
        assert_eq!(
            scoped_catalogs,
            [
                ("aft", Some("reader")),
                ("prefrontal", None),
                ("prefrontal", Some("sidekick"))
            ]
        );
    }
    assert_eq!(
        worker.sends.lock().unwrap()[0].0.project_root.as_deref(),
        fixture.root.to_str()
    );

    let plain_out = fixture.root.join("plain");
    spec["out_dir"] = json!(plain_out);
    spec["tools"] = json!(["reader"]);
    let plain = fixture
        .run_with(spec, Ends::LabTools(vec![]), available_sidekick)
        .await;
    assert_eq!(*plain.lab_send_projects.lock().unwrap(), [None]);
    assert!(plain
        .lab_catalog_projects
        .lock()
        .unwrap()
        .iter()
        .all(Option::is_none));
    assert!(plain
        .asked
        .lock()
        .unwrap()
        .iter()
        .all(|(provider, _)| provider == "aft"));
    assert_eq!(
        plain.sends.lock().unwrap()[0].0.project_root.as_deref(),
        fixture.root.to_str()
    );
}

#[tokio::test]
async fn opted_in_lab_plan_offers_only_sidekick_from_prefrontal() {
    let fixture = Fixture::new();
    let mut spec = fixture.spec_value();
    spec["tools"] = json!(["reader", "sidekick", "submit"]);
    let client = fixture
        .run_with(spec, Ends::LabTools(vec![]), available_sidekick)
        .await;
    let sends = client.sends.lock().unwrap();
    assert_eq!(sends.len(), 1);
    let plan = &sends[0].1.plan.as_ref().unwrap();
    assert_eq!(
        plan["tool_items"],
        json!([
            {"provider":"aft","preset":"reader","params":{}},
            {"provider":"prefrontal","preset":"sidekick","params":{}},
            {"provider":crate::MODULE_ID,"preset":"dreamer","params":{}}
        ])
    );
    assert_eq!(
        plan["composition"]["providers"],
        json!([
            {"provider":"aft","tools":[{"name":"aft_search","capabilities":[]},
                {"name":"read","capabilities":["code.read/v1"]}]},
            {"provider":crate::MODULE_ID,"tools":[{"name":"submit","capabilities":[]}]},
            {"provider":"prefrontal","tools":[{"name":"sidekick","capabilities":[]}]}
        ])
    );
    assert_eq!(fixture.output("run.json")["sidekick_offered"], true);
}

#[tokio::test]
async fn persona_facts_report_sidekick_and_checkout_paths_only_when_offered() {
    for enabled in [false, true] {
        let fixture = Fixture::new();
        let fact = "{% if tools.sidekick %}{% for path in checkout_paths %} {{ path }}{% endfor %}{% else %} unavailable{% endif %}";
        fs::write(
            fixture.persona.join("PERSONA.md"),
            format!("{SYSTEM}{fact}"),
        )
        .unwrap();
        fs::write(
            fixture.persona.join("first-message.md"),
            format!("{MESSAGE}{fact}"),
        )
        .unwrap();
        let mut spec = fixture.spec_value();
        if enabled {
            spec["tools"]
                .as_array_mut()
                .unwrap()
                .push(json!("sidekick"));
        }
        fixture
            .run_with(spec, Ends::LabTools(vec![]), available_sidekick)
            .await;
        let request = fixture.output("request.json");
        let expected = if enabled {
            fixture.checkout.to_str().unwrap()
        } else {
            "unavailable"
        };
        for field in ["system_text", "first_message"] {
            assert!(
                request[field].as_str().unwrap().ends_with(expected),
                "{field}: {}",
                request[field]
            );
        }
        assert_eq!(fixture.output("run.json")["sidekick_offered"], enabled);
    }
}

#[tokio::test]
async fn sidekick_preflight_refuses_before_send_when_not_installed() {
    assert_sidekick_refusal(None, &[], "not installed or not ready").await;
}

#[tokio::test]
async fn sidekick_preflight_refuses_before_send_when_the_preset_is_not_listed() {
    assert_sidekick_refusal(Some(&["worker"]), &["sidekick"], "listed [\"worker\"]").await;
}

#[tokio::test]
async fn sidekick_preflight_refuses_before_send_when_the_catalog_is_empty() {
    assert_sidekick_refusal(Some(&["sidekick"]), &[], "found []").await;
}

#[tokio::test]
async fn sidekick_preflight_refuses_before_send_when_the_catalog_offers_other_tools() {
    assert_sidekick_refusal(
        Some(&["sidekick"]),
        &["sidekick", "notify"],
        "found [\"sidekick\", \"notify\"]",
    )
    .await;
}

#[tokio::test]
async fn sidekick_preflight_refuses_before_send_when_the_tool_is_not_sidekick() {
    assert_sidekick_refusal(Some(&["sidekick"]), &["review"], "found \"review\"").await;
}

async fn assert_sidekick_refusal(presets: Option<&[&str]>, tools: &[&str], reason: &str) {
    let fixture = Fixture::new();
    let mut spec = fixture.spec_value();
    spec["tools"] = json!(["sidekick"]);
    let client = fixture
        .run_with(spec, Ends::LabTools(vec![]), |client| {
            if let Some(presets) = presets {
                sidekick_provider(client, presets, tools);
            }
        })
        .await;
    assert!(client.sends.lock().unwrap().is_empty());
    assert!(!fixture.out.join("request.json").exists());
    let run = fixture.output("run.json");
    assert_eq!(run["stop"], "refusal");
    assert_eq!(run["sidekick_offered"], false);
    let error = run["error"].as_str().unwrap();
    assert!(
        error.contains("sidekick unavailable from prefrontal"),
        "{error}"
    );
    assert!(error.contains(reason), "{error}");
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
    let lab = fixture.search_lab(None).await;
    let memory = lab
        .clone()
        .tool("memory_search", json!({"query":"sharedterm"}))
        .await
        .unwrap();
    let answer = lab
        .clone()
        .tool("history_search", json!({"query":"sharedterm"}))
        .await
        .unwrap();
    assert!(memory.contains("id=7"), "{memory}");
    assert!(
        !memory.contains("id=9") && !memory.contains("different project"),
        "{memory}"
    );
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
    assert!(!answer.contains("id=7"), "{answer}");
    {
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
        assert!(crate::search::lab::History::load(&db, "p", Some(&["unrelated".into()])).is_err());
    }
    let fixture = Fixture::new();
    let narrow = fixture
        .search_lab(Some(&["session-p"]))
        .await
        .tool("history_search", json!({"query":"sharedterm"}))
        .await
        .unwrap();
    assert!(narrow.contains("session=session-p ref=session-p:12"));
    assert!(!narrow.contains("session-p2"));
}

#[tokio::test]
async fn memory_search_does_not_use_history_session_selection() {
    let fixture = Fixture::new();
    let mut spec = fixture.spec_value();
    spec["history_sessions"] = json!(["unrelated"]);
    let lab = Arc::new(Lab::load(fixture.start(&spec).await.unwrap(), None).unwrap());
    let answer = lab
        .clone()
        .tool("memory_search", json!({"query":"#7"}))
        .await
        .unwrap();
    assert!(answer.contains("id=7"), "{answer}");
    let error = lab
        .tool("memory_search", json!({"query":"#7", "sources":["memory"]}))
        .await
        .unwrap_err();
    assert!(error.contains("does not accept \"sources\""), "{error}");
}

#[tokio::test]
async fn frozen_search_memory_only_even_when_messages_outranked_it() {
    let fixture = Fixture::new();
    let lab = fixture.search_lab(None).await;
    let answer = lab
        .clone()
        .tool("memory_search", json!({"query":"sharedterm", "limit":1}))
        .await
        .unwrap();
    assert!(answer.contains("id=7"), "{answer}");
    let answer = lab
        .tool("memory_search", json!({"query":"sharedterm"}))
        .await
        .unwrap();
    assert_eq!(answer.matches("[memory]").count(), 1, "{answer}");
    assert!(
        !answer.contains("[message]") && !answer.contains("[git_commit]"),
        "{answer}"
    );
}

#[tokio::test]
async fn frozen_search_agent_messages_require_opt_in_and_get_their_own_group() {
    let fixture = Fixture::new();
    let db = rusqlite::Connection::open(&fixture.frozen).unwrap();
    index_message(
        &db,
        "session-p",
        13,
        "assistant",
        "sharedterm from the agent.",
        1000,
    );
    drop(db);
    let lab = fixture.search_lab(None).await;
    let omitted = lab
        .clone()
        .tool("history_search", json!({"query":"sharedterm"}))
        .await
        .unwrap();
    assert!(
        !omitted.contains("from the agent") && !omitted.contains("## Agent messages"),
        "{omitted}"
    );
    let included = lab
        .tool(
            "history_search",
            json!({"query":"sharedterm", "include_agent":true}),
        )
        .await
        .unwrap();
    assert!(group(&included, "The person's messages").contains("ref=session-p:12"));
    assert!(!group(&included, "The person's messages").contains("from the agent"));
    assert!(group(&included, "Agent messages").contains("ref=session-p:13"));
}

#[tokio::test]
async fn frozen_search_sizes_multiply_independently_per_group() {
    let fixture = Fixture::new();
    let db = rusqlite::Connection::open(&fixture.frozen).unwrap();
    for n in 20..34 {
        index_message(&db, "session-p", n, "user", "groupterm human", 1000);
        index_message(
            &db,
            "session-p",
            n + 20,
            "assistant",
            "groupterm agent",
            1000,
        );
        db.execute("INSERT INTO compartments (session_id, harness, sequence, start_message, end_message, title, content, created_at)
                    VALUES ('session-p', 'mock', ?1, ?1, ?1, 'groupterm summary', 'groupterm summary', 2000)", [n]).unwrap();
        db.execute("INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at)
                    VALUES (?1, 'p', ?1, 'groupterm commit', 'author', ?2, 1000)", params![format!("commit-{n}"), n]).unwrap();
    }
    drop(db);
    let lab = fixture.search_lab(None).await;
    for (limit, multiplier) in [(Value::Null, 1), (json!(2), 2), (json!(99), 3)] {
        let mut input = json!({"query":"groupterm", "include_agent":true});
        if !limit.is_null() {
            input["limit"] = limit;
        }
        let answer = lab.clone().tool("history_search", input).await.unwrap();
        for (title, count, marker) in [
            ("Summaries", 4, "compartment_id="),
            ("The person's messages", 4, "ordinal="),
            ("Commits", 3, "sha="),
            ("Agent messages", 4, "ordinal="),
        ] {
            assert_eq!(
                group(&answer, title).matches(marker).count(),
                count * multiplier,
                "{answer}"
            );
        }
    }
    let empty = lab
        .tool(
            "history_search",
            json!({"query":"zznomatchzz", "include_agent":true}),
        )
        .await
        .unwrap();
    for title in [
        "Summaries",
        "The person's messages",
        "Commits",
        "Agent messages",
    ] {
        assert_eq!(group(&empty, title), "none", "{empty}");
    }
}

#[tokio::test]
async fn frozen_search_user_role_system_reminders_do_not_take_slots() {
    let fixture = Fixture::new();
    let db = rusqlite::Connection::open(&fixture.frozen).unwrap();
    for n in 20..35 {
        index_message(
            &db,
            "session-p",
            n,
            "user",
            "<system-reminder>noticeterm noticeterm noticeterm host notice</system-reminder>",
            1000,
        );
    }
    index_message(
        &db,
        "session-p",
        40,
        "user",
        "My actual noticeterm request.",
        1000,
    );
    drop(db);
    let lab = fixture.search_lab(None).await;
    let answer = lab
        .tool("history_search", json!({"query":"noticeterm"}))
        .await
        .unwrap();
    assert!(!answer.contains("host notice"), "{answer}");
    let user = group(&answer, "The person's messages");
    assert!(user.contains("My actual noticeterm request."), "{answer}");
    assert_eq!(user.matches("ordinal=").count(), 1, "{answer}");
}

#[tokio::test]
async fn frozen_search_dated_messages_use_inclusive_utc_bounds_and_total_tie_order() {
    let fixture = Fixture::new();
    let db = rusqlite::Connection::open(&fixture.frozen).unwrap();
    for (session, n, at) in [
        ("session-p", 16, 86_399_999),
        ("session-p2", 15, 86_399_999),
        ("session-p", 15, 86_399_999),
        ("session-p", 14, 0),
        ("session-p", 13, -1),
        ("session-p", 17, 86_400_000),
        ("unrelated", 15, 86_399_999),
    ] {
        index_message(&db, session, n, "user", "same tiebreakterm text", at);
    }
    drop(db);
    let lab = fixture.search_lab(None).await;
    let answer = lab
        .tool(
            "history_search",
            json!({"query":"tiebreakterm", "from":"1970-01-01", "to":"1970-01-01"}),
        )
        .await
        .unwrap();
    let user = group(&answer, "The person's messages");
    let references: Vec<_> = user
        .lines()
        .filter_map(|line| line.split_once(" ref=").map(|(_, r)| r))
        .collect();
    assert_eq!(
        references,
        [
            "session-p:15",
            "session-p:16",
            "session-p2:15",
            "session-p:14"
        ],
        "{answer}"
    );
}

#[tokio::test]
async fn frozen_search_archived_memory_follows_active_and_is_citable_by_id() {
    let fixture = Fixture::new();
    let db = rusqlite::Connection::open(&fixture.frozen).unwrap();
    let words = format!("{} an ending beyond the character cap", "é".repeat(600));
    db.execute(
        "UPDATE memories SET content=?1, status='archived' WHERE id=2",
        [format!("sharedterm sharedterm {words}")],
    )
    .unwrap();
    drop(db);
    let lab = fixture.search_lab(None).await;
    let answer = lab
        .clone()
        .tool("memory_search", json!({"query":"sharedterm"}))
        .await
        .unwrap();
    let active = answer.find("id=7").expect("active memory");
    let archived = answer
        .find("id=2")
        .unwrap_or_else(|| panic!("missing archived memory: {answer}"));
    assert!(active < archived, "{answer}");
    assert!(
        answer[active..archived].contains("status=active"),
        "{answer}"
    );
    assert!(
        answer[archived..].contains("status=archived")
            && answer[archived..].contains("importance=72"),
        "{answer}"
    );
    let text = answer[archived..].split_once('\n').unwrap().1;
    assert_eq!(text.strip_suffix('…').unwrap().chars().count(), 600);
    let ids = lab
        .tool("memory_search", json!({"query":"#2, #7, #9"}))
        .await
        .unwrap();
    assert!(
        ids.find("id=7").unwrap() < ids.find("id=2").unwrap(),
        "{ids}"
    );
    assert!(!ids.contains("id=9"), "{ids}");
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
    let lab = fixture.search_lab(None).await;
    let memory = lab
        .clone()
        .tool("memory_search", json!({"query":"sharedterm"}))
        .await
        .unwrap();
    assert!(
        memory.contains("id=7") && !memory.contains("session-p"),
        "{memory}"
    );
    let answer = lab
        .tool("history_search", json!({"query":"sharedterm"}))
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
    assert!(group(&answer, "Summaries").contains("ref=session-p:1-4"));
}

#[tokio::test]
async fn history_omits_sessions_mapped_to_multiple_harnesses_in_the_same_project() {
    let fixture = Fixture::new();
    let db = rusqlite::Connection::open(&fixture.frozen).unwrap();
    db.execute_batch(
        "INSERT INTO session_projects (session_id, harness, project_path, updated_at)
             VALUES ('session-p', 'other', 'p', 1);
         INSERT INTO compartments (session_id, harness, sequence, start_message, end_message, title, content, created_at)
             VALUES ('session-p', 'other', 2, 1, 4, 'other sharedterm summary', 'same bare session id', 2000);",
    ).unwrap();
    drop(db);
    let mut spec = fixture.spec_value();
    spec["tools"] = json!(["history_search"]);
    let client = fixture
        .run(
            spec,
            Ends::LabTools(vec![
                json!({"name":"history_search", "arguments":{"query":"sharedterm"}}),
            ]),
        )
        .await;
    let calls = client.lab_tool_results.lock().unwrap();
    let answer = calls[0]["content"][0]["text"].as_str().unwrap();
    assert!(
        answer.contains("ref=session-p2:12") && answer.contains("ref=session-p2:1-4"),
        "{answer}"
    );
    assert!(
        !answer.contains("ref=session-p:") && !answer.contains("same bare session id"),
        "{answer}"
    );
    assert_eq!(fixture.output("run.json")["history_session_ids_skipped"], 1);
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
