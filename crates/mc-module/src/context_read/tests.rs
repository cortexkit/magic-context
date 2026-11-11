use super::*;

fn reader() -> Reader {
    Reader {
        context: None,
        store: None,
        config: Arc::new(crate::pass::Settings::default().into()),
        projects: Default::default(),
        gate: Default::default(),
    }
}

fn request(method: &str, params: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"method": method, "params": params})).unwrap()
}

fn params() -> Value {
    json!({"session": {"harness": "opencode", "session": "plugin"}, "purpose": "bias", "budget_tokens": 32768})
}

#[test]
fn context_read_describe_lists_only_the_two_read_ops_without_a_store() {
    let answer = reader().read(&request("role.describe", json!({}))).unwrap();
    assert_eq!(answer["majors"][0]["version"], "mc-context-read/v1");
    assert_eq!(
        answer["majors"][0]["ops"],
        json!(["context.memories", "context.summaries"])
    );
}

#[test]
fn context_read_purpose_is_a_closed_set() {
    for purpose in [json!("everything"), json!(""), json!(true), Value::Null] {
        let mut p = params();
        p["purpose"] = purpose;
        let error = reader().read(&request("context.memories", p)).unwrap_err();
        assert_eq!(error.code, "invalid_params");
        assert_eq!(error.detail.unwrap()["field"], "purpose");
    }
}

#[test]
fn context_read_budget_requires_an_integer_in_range() {
    for budget in [
        json!(0),
        json!(-1),
        json!(32769),
        json!(1.5),
        json!("100"),
        Value::Null,
    ] {
        for method in OPS {
            let mut p = params();
            if method == "context.summaries" {
                p.as_object_mut().unwrap().remove("purpose");
            }
            p["budget_tokens"] = budget.clone();
            let error = reader().read(&request(method, p)).unwrap_err();
            assert_eq!(error.code, "invalid_params");
            assert_eq!(error.detail.unwrap()["field"], "budget_tokens");
        }
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    reader: Reader,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("context.db");
        let db = ContextDb::create_for_tests(&path).unwrap();
        db.with_connection(|conn| {
            conn.execute_batch("INSERT INTO session_meta(session_id,harness) VALUES('plugin','opencode'),('empty','pi');
                INSERT INTO session_projects VALUES('plugin','opencode','own',0);
                INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(1,'Workspace',0,0);
                INSERT INTO workspace_members VALUES(1,'own','Alpha','/a',0),(1,'other','Beta','/b',0);").unwrap();
            for (id, project, category, content, importance, status) in [
                (1, "own", "CONSTRAINTS", "Oversized fact ".repeat(300), 100, "active"),
                (2, "own", "PROJECT_RULES", "Ada maintains the parser".into(), 80, "active"),
                (3, "other", "CONSTRAINTS", "Lin maintains the reader".into(), 10, "permanent"),
                (4, "other", "PROJECT_RULES", "PRIVATE FOREIGN FACT".into(), 100, "active"),
                (5, "own", "CONSTRAINTS", "EXPIRED FACT".into(), 100, "active"),
                (6, "own", "CONSTRAINTS", "ARCHIVED FACT".into(), 100, "archived"),
            ] {
                conn.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,shareable,scope,importance,status,expires_at,first_seen_at,created_at,updated_at,last_seen_at) VALUES(?1,?2,?3,?4,?5,1,'project',?6,?7,?8,0,0,0,0)", params![id,project,category,content,format!("hash-{id}"),importance,status,if id == 5 {Some(1)} else {None}]).unwrap();
            }
            for sequence in 0..12 {
                conn.execute("INSERT INTO compartments(session_id,harness,sequence,start_message,end_message,title,content,p1,p2,p3,p4,importance,created_at) VALUES('plugin','opencode',?1,?2,?3,?4,'flat','verbose fact','short fact','anchor fact','tiny fact',50,0)", params![sequence, sequence*10+1,sequence*10+10,format!("Summary {sequence}")]).unwrap();
            }
        });
        drop(db);
        let reader = Reader {
            context: Some(path),
            ..reader()
        };
        Self { _dir: dir, reader }
    }

    fn read(&self, method: &str, mut p: Value) -> Value {
        if method == "context.summaries" {
            p.as_object_mut().unwrap().remove("purpose");
        }
        self.reader.read(&request(method, p)).unwrap()
    }
}

#[test]
fn context_read_unknown_session_precedes_any_other_store_or_content_read() {
    let mut fixture = Fixture::new();
    fixture.reader.store = Some(fixture._dir.path().join("does-not-exist.db"));
    let conn = Connection::open(fixture.reader.context.as_ref().unwrap()).unwrap();
    conn.execute_batch("DROP TABLE memories; DROP TABLE compartments;")
        .unwrap();
    for method in OPS {
        let mut p = params();
        p["session"]["session"] = json!("unknown");
        if method == "context.summaries" {
            p.as_object_mut().unwrap().remove("purpose");
        }
        assert_eq!(
            fixture.reader.read(&request(method, p)).unwrap_err().code,
            "unknown_session"
        );
    }
}

#[test]
fn context_read_front_and_projectless_sessions_receive_no_memories() {
    let fixture = Fixture::new();
    let mut p = params();
    p["purpose"] = json!("front");
    assert_eq!(
        fixture.read("context.memories", p.clone())["memories"],
        json!([])
    );
    p["purpose"] = json!("bias");
    p["session"] = json!({"harness":"pi","session":"empty"});
    assert_eq!(
        fixture.read("context.memories", p.clone())["memories"],
        json!([])
    );
    assert_eq!(fixture.read("context.summaries", p)["summaries"], json!([]));
}

#[test]
fn context_read_memories_reuse_head_selection_and_priority_with_workspace_labels() {
    let fixture = Fixture::new();
    let mut p = params();
    p["budget_tokens"] = json!(100);
    let answer = fixture.read("context.memories", p);
    let items = answer["memories"].as_array().unwrap();
    assert_eq!(
        items
            .iter()
            .map(|m| m["id"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        [3, 2]
    );
    assert_eq!(items[0]["project"], "Beta");
    assert!(items[1].get("project").is_none());
    assert_eq!(items[0]["text"], "Lin maintains the reader");
    assert_eq!(items[1]["category"], "PROJECT_RULES");
    assert_eq!(
        items[0]["tokens"],
        mc_tokenizer::estimate_tokens("Lin maintains the reader")
    );
    assert_eq!(answer["token_family"], "mc-estimator");
    assert_eq!(answer["exact"], false);
    let (snapshot, _) = fixture
        .reader
        .snapshot("opencode", "plugin", Some("bias"))
        .unwrap();
    let workspace = snapshot.workspace.as_ref().unwrap();
    let inputs = head::Inputs {
        counter: Counter::for_model(None),
        summaries: &[],
        docs: "",
        profile: &[],
        profile_max_id: 0,
        memories: &snapshot.memories,
        workspace: Some(workspace),
        gone: &[],
        history_budget_tokens: 0,
        history_local_budget_tokens: 0,
        memory_budget_tokens: 100,
        profile_budget_tokens: 0,
    };
    let mut head_ids = head::fold(&inputs, None).shown_ids();
    head_ids.sort();
    let mut service_ids = items
        .iter()
        .map(|m| m["id"].as_i64().unwrap())
        .collect::<Vec<_>>();
    service_ids.sort();
    assert_eq!(service_ids, head_ids);
}

#[test]
fn context_read_plugin_summaries_use_existing_no_pressure_decay_newest_first() {
    let fixture = Fixture::new();
    let answer = fixture.read("context.summaries", params());
    let items = answer["summaries"].as_array().unwrap();
    assert_eq!(items.len(), 12);
    assert_eq!(items[0]["id"], "11");
    assert_eq!(items[0]["start"], 111);
    assert_eq!(items[0]["end"], 120);
    assert_eq!(items[0]["title"], "Summary 11");
    assert!(items[0]["text"].as_str().unwrap().contains("verbose fact"));
    assert!(items[11]["text"].as_str().unwrap().contains("short fact"));
    assert!(!items[11]["text"].as_str().unwrap().contains("verbose fact"));
    assert_eq!(
        items[0]["tokens"],
        mc_tokenizer::estimate_tokens(items[0]["text"].as_str().unwrap())
    );
    let (snapshot, _) = fixture.reader.snapshot("opencode", "plugin", None).unwrap();
    let rendered =
        render::render_stored_compartments(&snapshot.summaries, 0.0, mc_tokenizer::estimate_tokens);
    assert!(items
        .iter()
        .all(|item| rendered.contains(item["text"].as_str().unwrap())));
}

#[test]
fn context_read_summaries_stop_at_the_first_item_that_does_not_fit() {
    let fixture = Fixture::new();
    let conn = Connection::open(fixture.reader.context.as_ref().unwrap()).unwrap();
    conn.execute_batch("DELETE FROM compartments WHERE sequence > 2;")
        .unwrap();
    conn.execute(
        "UPDATE compartments SET p1=?1 WHERE sequence=1",
        ["large fact ".repeat(500)],
    )
    .unwrap();
    let full = fixture.read("context.summaries", params());
    let newest = full["summaries"][0]["tokens"].as_u64().unwrap();
    let oldest = full["summaries"][2]["tokens"].as_u64().unwrap();
    let mut p = params();
    p["budget_tokens"] = json!(newest + oldest);
    let answer = fixture.read("context.summaries", p.clone());
    assert_eq!(answer["summaries"].as_array().unwrap().len(), 1);
    assert_eq!(answer["summaries"][0], full["summaries"][0]);
    p["budget_tokens"] = json!(newest);
    assert_eq!(
        fixture.read("context.summaries", p.clone())["summaries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    p["budget_tokens"] = json!(newest - 1);
    assert_eq!(fixture.read("context.summaries", p)["summaries"], json!([]));
}

#[test]
fn context_read_uses_the_recorded_plugin_model_and_never_writes() {
    let fixture = Fixture::new();
    let path = fixture.reader.context.as_ref().unwrap();
    let conn = Connection::open(path).unwrap();
    conn.execute("UPDATE session_meta SET last_observed_model_key='anthropic/claude-opus-5-5', detected_context_limit=100000 WHERE session_id='plugin'", []).unwrap();
    drop(conn);
    let before = std::fs::read(path).unwrap();
    let answer = fixture.read("context.memories", params());
    assert_eq!(answer["exact"], true);
    assert_eq!(answer["token_family"], "ClaudeV5");
    for item in answer["memories"].as_array().unwrap() {
        let text = item["text"].as_str().unwrap();
        assert_eq!(
            item["tokens"],
            cortexkit_tokens::count(cortexkit_tokens::Family::ClaudeV5, text).unwrap()
        );
    }
    fixture.read("context.summaries", params());
    assert_eq!(std::fs::read(path).unwrap(), before);
    assert!(open(path)
        .unwrap()
        .execute("DELETE FROM memories", [])
        .is_err());
}

#[test]
fn context_read_plugin_project_identity_is_not_a_configuration_directory() {
    let fixture = Fixture::new();
    let conn = Connection::open(fixture.reader.context.as_ref().unwrap()).unwrap();
    conn.execute("UPDATE session_projects SET project_path='git:identity-not-a-directory' WHERE session_id='plugin'", []).unwrap();
    let (snapshot, _) = fixture.reader.snapshot("opencode", "plugin", None).unwrap();
    assert_eq!(snapshot.project.unwrap().id, "git:identity-not-a-directory");
    // Only this value is passed to configuration resolution, which opens project files.
    assert_eq!(snapshot.config_root, None);
}

#[tokio::test]
async fn context_read_held_mode3_head_uses_its_live_project_and_persisted_conditions() {
    use crate::store::{Durable, Store};
    use crate::transport::SubcRunnerClient;
    use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
    use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
    let fixture = Fixture::new();
    let path = fixture.reader.context.as_ref().unwrap();
    let db = ContextDb::open(path).unwrap();
    db.with_connection(|conn| conn.execute_batch("INSERT INTO session_meta(session_id,harness) VALUES('held','opencode2'); INSERT INTO compartments(session_id,harness,sequence,start_message,end_message,title,content,p1,p2,p3,p4,importance,created_at) VALUES('held','opencode2',0,1,10,'Held summary','flat','held fact','short','anchor','tiny',50,0);").unwrap());
    let key = SessionRef::new("runner", "opencode2", "held");
    let store = Store::open(&fixture._dir.path().join("mode3.db")).unwrap();
    let setup = SetupRequest::new(
        crate::catalog::Preset::Worker.as_str(),
        ModelRef::new("anthropic", "claude-opus-5-5"),
        100000,
        1000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        Vec::new(),
        1,
    );
    let conditions = Conditions::new(
        setup.model.clone(),
        setup.context_window,
        setup.output_reserve,
        setup.rules.clone(),
    );
    store
        .save(
            &key,
            &Durable {
                compaction: Some((crate::preset::Features::NONE, conditions)),
                ..Durable::default()
            },
        )
        .unwrap();
    let module = crate::module::Module::new(
        SubcRunnerClient::new(
            fixture._dir.path().join("unused-connection"),
            Arc::new(crate::child_scopes::ChildScopes::new("test")),
        ),
        crate::pass::Settings::default(),
        Some(db),
        Some(store),
    );
    // Held in mode3.db but not set up since this module started: its project
    // is unknown, so memories answer "try later" rather than an empty list.
    let mut p = params();
    p["session"] = json!({"harness":"opencode2","session":"held"});
    let pending = module
        .context_read()
        .read(&request("context.memories", p.clone()))
        .await
        .unwrap_err();
    assert_eq!(pending.code, "project_pending");
    assert_eq!(pending.detail.as_ref().unwrap()["class"], "transient");
    // Summaries need no project and answer at once.
    let mut summaries = p.clone();
    summaries.as_object_mut().unwrap().remove("purpose");
    assert!(module
        .context_read()
        .read(&request("context.summaries", summaries))
        .await
        .is_ok());
    module
        .setup(
            crate::route::Route {
                session: key,
                project: Some(Project {
                    id: "own".into(),
                    root: fixture._dir.path().to_string_lossy().into(),
                }),
                workdir: None,
                agent_id: None,
            },
            setup,
        )
        .unwrap();
    let answer = module
        .context_read()
        .read(&request("context.memories", p.clone()))
        .await
        .unwrap();
    assert!(!answer["memories"].as_array().unwrap().is_empty());
    assert_eq!(answer["exact"], true);
    p.as_object_mut().unwrap().remove("purpose");
    let answer = module
        .context_read()
        .read(&request("context.summaries", p))
        .await
        .unwrap();
    assert_eq!(answer["summaries"][0]["title"], "Held summary");
    assert!(answer["summaries"][0]["text"]
        .as_str()
        .unwrap()
        .contains("held fact"));
}

#[test]
#[ignore = "release-profile read-transaction hold measurement"]
fn context_read_werni_sized_read_holds_stay_under_250_ms() {
    let mut fixture = Fixture::new();
    let store_path = fixture._dir.path().join("mode3.db");
    let store = crate::store::Store::open(&store_path).unwrap();
    store
        .save(
            &SessionRef::new("runner", "opencode", "plugin"),
            &crate::store::Durable::default(),
        )
        .unwrap();
    drop(store);
    fixture.reader.store = Some(store_path);
    let mut conn = Connection::open(fixture.reader.context.as_ref().unwrap()).unwrap();
    let tx = conn.transaction().unwrap();
    tx.execute_batch("DELETE FROM memories; DELETE FROM compartments;")
        .unwrap();
    for id in 1..=1300 {
        tx.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,importance,first_seen_at,created_at,updated_at,last_seen_at) VALUES(?1,'own','PROJECT_RULES',?2,?3,80,1,1,1,1)", params![id,format!("Parser rule {id}: validate the versioned input. {}", "Keep diagnostics stable across releases. ".repeat(6)),format!("measurement-{id}")]).unwrap();
    }
    for sequence in 0..93 {
        let start = sequence * 9000 / 93 + 1;
        let end = (sequence + 1) * 9000 / 93;
        let text = format!(
            "History {sequence}: {}",
            "We validated the input and kept the diagnostic contract. ".repeat(16)
        );
        tx.execute("INSERT INTO compartments(session_id,harness,sequence,start_message,end_message,title,content,p1,p2,p3,p4,importance,created_at) VALUES('plugin','opencode',?1,?2,?3,?4,?5,?5,?5,?5,?5,50,1)",params![sequence,start,end,format!("History {sequence}"),text]).unwrap();
    }
    for n in 1..=9000 {
        let mid = format!("msg{n:05}");
        let text = format!(
            "Historical message {n}: {}",
            "Investigate parser validation and maintain stable release diagnostics. ".repeat(8)
        );
        tx.execute("INSERT INTO message_history_source(session_id,message_id,message_ordinal,source_version,normalized_content_hash,role,harness,updated_at) VALUES('plugin',?1,?2,'seed',?3,'user','opencode',1)", params![mid,n,format!("message-{n}")]).unwrap();
        tx.execute("INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES('plugin',?1,?2,'user',?3)",params![n,mid,text]).unwrap();
        tx.execute("INSERT INTO tags(session_id,message_id,type,tag_number,harness) VALUES('plugin',?1,'message',?2,'opencode')",params![mid,n]).unwrap();
    }
    tx.commit().unwrap();
    for (table, count) in [
        ("message_history_source", 9000),
        ("memories", 1300),
        ("compartments", 93),
    ] {
        assert_eq!(
            conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            count
        );
    }
    for (op, purpose) in [
        ("context.memories", Some("bias")),
        ("context.summaries", None),
    ] {
        let mut max = Duration::ZERO;
        for _ in 0..10 {
            let (snapshot, hold) = fixture
                .reader
                .snapshot("opencode", "plugin", purpose)
                .unwrap();
            assert_eq!(
                if purpose.is_some() {
                    snapshot.memories.len()
                } else {
                    snapshot.summaries.len()
                },
                if purpose.is_some() { 1300 } else { 93 }
            );
            max = max.max(hold);
        }
        eprintln!("{op}: 10 read transactions, max hold {:.3} ms (9000 messages, 93 summaries, 1300 memories)", max.as_secs_f64()*1000.0);
        assert!(max < Duration::from_millis(250), "{op}: {max:?}");
    }
}
