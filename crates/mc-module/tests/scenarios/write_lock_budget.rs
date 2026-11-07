//! Large shared-store measurements; all data is synthetic and disposable.

use super::*;
use mc_module::context_db::timing::Sample;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

const MESSAGES: usize = 9_000;
const MEMORIES: i64 = 1_300;
const SUMMARIES: usize = 93;
const DIMENSIONS: usize = 1_024;

fn seed(dir: &Path, model_id: &str) {
    drop(ContextDb::create_for_tests(&dir.join("context.db")).unwrap());
    let mut conn = Connection::open(dir.join("context.db")).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    let tx = conn.transaction().unwrap();
    tx.execute("INSERT INTO memory_sync_state(device,account,enrollment_state,next_local_id,hlc_wall_ms,hlc_logical) VALUES('22222222222222222222222222222222','11111111111111111111111111111111','enrolled',1,0,0)", []).unwrap();
    let vector: Vec<u8> = (0..DIMENSIONS)
        .flat_map(|n| (if n == 0 { 1.0_f32 } else { 0.0_f32 }).to_le_bytes())
        .collect();
    for id in 1..=MEMORIES {
        let content = format!(
            "Parser rule {id}: validate the versioned input before changing field {id}. {}",
            "Keep diagnostics stable across releases. ".repeat(6)
        );
        tx.execute(
            "INSERT INTO memories (id, project_path, category, content, normalized_hash, importance,
             first_seen_at, created_at, updated_at, last_seen_at, mural_cue, mural_cue_hash)
             VALUES (?1, 'pj-test', 'PROJECT_RULES', ?2, ?3, 80, 1, 1, 1, 1, ?4, ?3)",
            params![id, content, format!("{:x}", Sha256::digest(content.as_bytes())), format!("validate input→field {id}")],
        ).unwrap();
        tx.execute(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?1, ?2, ?3)",
            params![id, vector, model_id],
        )
        .unwrap();
    }
    for sequence in 0..SUMMARIES {
        let start = sequence * MESSAGES / SUMMARIES + 1;
        let end = (sequence + 1) * MESSAGES / SUMMARIES;
        let content = format!(
            "History {sequence}: parser invariants and decisions. {}",
            "We validated the input and kept the diagnostic contract. ".repeat(16)
        );
        tx.execute(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message,
             start_message_id, end_message_id, title, content, p1, p2, p3, p4, created_at, harness)
             VALUES ('s1', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7, ?7, ?7, 1, 'mock')",
            params![
                sequence as i64,
                start as i64,
                end as i64,
                format!("msg{start:05}"),
                format!("msg{end:05}"),
                format!("History {sequence}"),
                content
            ],
        )
        .unwrap();
    }
    for n in 1..=MESSAGES {
        let mid = format!("msg{n:05}");
        let content = format!(
            "Historical message {n}: {}",
            "Investigate parser validation and maintain stable release diagnostics. ".repeat(8)
        );
        tx.execute("INSERT INTO message_history_source (session_id, message_id, message_ordinal, source_version, normalized_content_hash, role, harness, updated_at) VALUES ('s1', ?1, ?2, 'seed', ?3, 'user', 'mock', 1)", params![mid, n as i64, format!("{:x}", Sha256::digest(content.as_bytes()))]).unwrap();
        tx.execute("INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES ('s1', ?1, ?2, 'user', ?3)", params![n as i64, mid, content]).unwrap();
        tx.execute("INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms) VALUES ('s1', ?1, ?2, 1)", params![n as i64, tx.last_insert_rowid()]).unwrap();
        tx.execute("INSERT INTO tags (session_id, message_id, type, tag_number, harness) VALUES ('s1', ?1, 'message', ?2, 'mock')", params![mid, n as i64]).unwrap();
    }
    tx.execute("INSERT INTO message_history_index (session_id, harness, last_indexed_ordinal, dirty_floor_ordinal, updated_at) VALUES ('s1', 'mock', ?1, 0, 1)", [MESSAGES as i64]).unwrap();
    for n in 1..=400 {
        tx.execute("INSERT INTO notes (type, status, content, session_id, harness, project_path, created_at, updated_at, anchor_ordinal) VALUES ('session', 'active', ?1, 's1', 'mock', 'pj-test', 1, 1, ?2)", params![format!("Review parser diagnostic {n} before release."), n]).unwrap();
    }
    for n in 1..=2_000 {
        tx.execute("INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at) VALUES (?1, 'pj-test', ?2, ?3, 'Synthetic', 1, 1)", params![format!("{n:040x}"), format!("{n:07x}"), format!("Parser maintenance change {n}")]).unwrap();
    }
    tx.commit().unwrap();
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
}

fn tool(name: &str, input: Value) -> Step {
    Step::Model(Turn {
        text: Some("Recording the decision.".into()),
        tools: vec![ToolCall::ok(name, input, "")],
        output_tokens: 5,
        ..Turn::default()
    })
}

#[derive(Default)]
struct Measurements(Vec<(&'static str, Sample)>);

impl Measurements {
    fn collect(&mut self, phase: &'static str, samples: Vec<Sample>) {
        assert!(
            !samples.is_empty(),
            "{phase}: no database operations measured"
        );
        self.0
            .extend(samples.into_iter().map(|sample| (phase, sample)));
    }

    fn check(&self) {
        let mut rows = BTreeMap::<(String, String), (usize, Duration, usize, Duration)>::new();
        for (phase, sample) in &self.0 {
            let site = format!("{}:{}", sample.site.file(), sample.site.line());
            let row = rows.entry((phase.to_string(), site)).or_default();
            row.0 += 1;
            row.1 = row.1.max(sample.elapsed);
            if sample.wrote {
                row.2 += 1;
                row.3 = row.3.max(sample.elapsed);
            }
        }
        println!("phase | call site | calls | max mutex ms | writes | max write bound ms");
        for ((phase, site), (calls, mutex, writes, hold)) in rows {
            println!(
                "{phase} | {site} | {calls} | {:.3} | {writes} | {:.3}",
                mutex.as_secs_f64() * 1_000.0,
                hold.as_secs_f64() * 1_000.0
            );
        }
        let violations: Vec<_> = self
            .0
            .iter()
            .filter(|(_, sample)| {
                sample.elapsed > Duration::from_millis(if sample.wrote { 100 } else { 250 })
            })
            .collect();
        assert!(
            violations.is_empty(),
            "context.db lock budget exceeded: {violations:?}"
        );
    }
}

#[test]
#[should_panic(expected = "context.db lock budget exceeded")]
fn a_write_over_one_hundred_milliseconds_fails_the_budget() {
    Measurements(vec![(
        "over-budget",
        Sample {
            site: std::panic::Location::caller(),
            elapsed: Duration::from_millis(101),
            wrote: true,
        },
    )])
    .check();
}

#[test]
#[should_panic(expected = "context.db lock budget exceeded")]
fn a_read_over_two_hundred_fifty_milliseconds_fails_the_mutex_budget() {
    Measurements(vec![(
        "over-budget",
        Sample {
            site: std::panic::Location::caller(),
            elapsed: Duration::from_millis(251),
            wrote: false,
        },
    )])
    .check();
}

/// A local embedding service that answers every document in a batch.
async fn embeddings() -> mc_module::embedding::Provider {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let (end, length) = loop {
                    let mut chunk = [0; 8192];
                    let read = socket.read(&mut chunk).await.unwrap();
                    assert!(read > 0);
                    bytes.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&bytes);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length:")?
                                    .trim()
                                    .parse::<usize>()
                                    .ok()
                            })
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            break (end + 4, length);
                        }
                    }
                };
                let request: Value = serde_json::from_slice(&bytes[end..end + length]).unwrap();
                let count = request["input"].as_array().map_or(1, Vec::len);
                let vector: Vec<f32> = (0..DIMENSIONS)
                    .map(|n| if n == 0 { 1.0 } else { 0.0 })
                    .collect();
                let data: Vec<Value> = (0..count)
                    .map(|index| json!({"index": index, "embedding": vector}))
                    .collect();
                let body = json!({"model": "mock-embed", "data": data}).to_string();
                let response = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                socket.write_all(response.as_bytes()).await.unwrap();
            });
        }
    });
    mc_module::embedding::Provider::from_tiers(
        &json!({"embedding": {"provider": "openai-compatible", "endpoint": format!("http://{address}/v1"), "model": "mock-embed"}}),
        &json!({}), Path::new("/"),
    ).unwrap()
}

// Run on Linux: cargo test --locked --release -p mc-module --features context-db-timing \
// --test scenarios write_lock_budget::werni_sized_writes_stay_within_budget -- --ignored --nocapture
#[tokio::test]
#[ignore = "release-mode large-store lock measurement; command above"]
async fn werni_sized_writes_stay_within_budget() {
    use cortexkit_role_compaction::read::{Cursor, Role};
    use mc_module::move_in::{move_in, MoveRequest};
    let dir = scratch("write-lock-budget");
    let provider = embeddings().await;
    seed(&dir, &provider.model_id());
    {
        let conn = Connection::open(dir.join("context.db")).unwrap();
        for (table, expected) in [
            ("memories", MEMORIES),
            ("memory_embeddings", MEMORIES),
            ("compartments", SUMMARIES as i64),
            ("notes", 400),
            ("message_history_source", MESSAGES as i64),
            ("message_history_fts", MESSAGES as i64),
            ("git_commits", 2_000),
        ] {
            let found: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(found, expected, "seeded {table}");
        }
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
    }
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["commit", "-q", "--allow-empty", "-m", "Add parser"],
        vec!["commit", "-q", "--allow-empty", "-m", "Fix parser"],
    ] {
        assert!(std::process::Command::new("git")
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false"
            ])
            .args(args)
            .current_dir(&repo)
            .status()
            .unwrap()
            .success());
    }
    let settings = Settings {
        embedding: Some(provider),
        git_commits_enabled: true,
        mural_enabled: true,
        memory_budget_tokens: 800,
        ..Settings::default()
    };
    let mut config = mural_config(&repo, Some(true));
    config.kind = Kind::OpenAi;
    let mut measurements = Measurements::default();
    let db = ContextDb::open(&dir.join("context.db")).unwrap();
    let recorder = db.lock_recorder();
    let store = Store::open(&dir.join("mode3.db")).unwrap();
    let moved = move_in(
        db,
        &store,
        &settings.clone().into(),
        &MoveRequest {
            session: config.session.clone(),
            preset: "head".into(),
            project: Some(RouteProject {
                id: "pj-test".into(),
                root: repo.to_string_lossy().into_owned(),
            }),
            model: config.model.clone(),
            context_window: config.context_window,
            output_reserve: config.output_reserve,
            rules: free(),
            newest: Cursor::new(MESSAGES as u64, "msg09000", "seed"),
            now: 1_000_000,
            messages: None,
            source_harness: None,
            source_session: None,
            source_runner_entries: false,
            tag_floor: None,
            before_newest: Some(format!("msg{:05}", MESSAGES - 1)),
        },
    )
    .unwrap();
    assert_eq!(moved.tag_checkpoint, MESSAGES as u64);
    measurements.collect("move-in", recorder.take());
    drop(store);
    config.tag_checkpoint = moved.tag_checkpoint;
    config.moved_in = Some(mc_mock_runner::runner::MovedIn {
        messages: (1..=MESSAGES)
            .map(|n| {
                (
                    if n % 2 == 1 {
                        Role::User
                    } else {
                        Role::Assistant
                    },
                    format!("Old message {n}."),
                )
            })
            .collect(),
        view: moved.view,
    });
    let records: Vec<Value> = serde_json::from_str(include_str!(
        "../../testdata/entorhinal-memory-context-v1/context-project.json"
    ))
    .unwrap();
    let mut context = records[0]["reply"]["result"].clone();
    context["domain"] = Value::Null;
    let client = HostClient::default();
    *client.entorhinal.lock().unwrap() = Some(context);
    let mut runner = start_with_client(
        client,
        config,
        settings.clone(),
        Some(dir.clone()),
        false,
        |_| {},
    )
    .await;
    runner
        .provider()
        .module()
        .idle(&runner.provider().route.session)
        .await
        .unwrap();
    measurements.collect(
        "setup",
        runner.provider().module().take_context_lock_samples(),
    );
    runner.play(&[user("Keep the parser conventions.")]).await;
    for (phase, step) in [
        (
            "ctx-memory-write",
            tool(
                "ctx_memory",
                json!({"action":"write", "category":"NAMING", "content":"Crates use kebab-case.", "ids":[]}),
            ),
        ),
        (
            "ctx-memory-write",
            tool(
                "ctx_memory",
                json!({"action":"write", "category":"NAMING", "content":"Modules use snake_case.", "ids":[]}),
            ),
        ),
        (
            "ctx-memory-update",
            tool(
                "ctx_memory",
                json!({"action":"update", "ids":[1301], "category":"NAMING", "content":"Crates always use kebab-case."}),
            ),
        ),
        (
            "ctx-memory-merge",
            tool(
                "ctx_memory",
                json!({"action":"merge", "ids":[1301,1302], "category":"NAMING", "content":"Crates use kebab-case; modules use snake_case."}),
            ),
        ),
        (
            "ctx-note-write",
            tool(
                "ctx_note",
                json!({"action":"write", "content":"Check parser diagnostics before release."}),
            ),
        ),
        (
            "ctx-search-accounting",
            tool(
                "ctx_search",
                json!({"query":"parser validation", "limit":5}),
            ),
        ),
    ] {
        runner.play(&[step]).await;
        assert_clean(&runner);
        measurements.collect(
            phase,
            runner.provider().module().take_context_lock_samples(),
        );
    }
    runner.play(&[answer()]).await;
    assert_clean(&runner);
    let outputs = tool_outputs(runner.host(), "ctx_memory");
    assert!(outputs[0].contains("Saved memory"), "{outputs:?}");
    assert!(outputs[2].contains("Updated memory"), "{outputs:?}");
    assert!(outputs[3].contains("Merged"), "{outputs:?}");
    measurements.collect(
        "tools-and-search-index",
        runner.provider().module().take_context_lock_samples(),
    );

    let summarizer = mc_mock_runner::child::scripted_summarizer();
    runner.host().set_responder(Arc::new(move |settings, prompt| {
        use mc_mock_runner::child as mock;
        let mut reply = summarizer(settings, prompt);
        if prompt.contains(mock::TURN_TWO_FACT) {
            reply.text = mock::turn_two_reply(&mock::facts_of(prompt).into_iter().map(|(id, _)| format!(r#"{{"fact_id":{id},"action":"new","check":"no memory states it"}}"#)).collect::<Vec<_>>());
        } else if prompt.contains(mock::TURN_ONE_FORMAT) {
            let xml = mock::summarize(prompt);
            let first = xml.split_once("<compartment start=\"").unwrap().1.split('"').next().unwrap();
            reply.text = mock::turn_one_reply(&xml.replace("</output>", &format!("<facts><PROJECT_RULES>\n* [at_compartment=1 messages={first}] Releases need two reviewers.\n</PROJECT_RULES></facts>\n</output>")));
        } else {
            reply.text = reply.text.replace("</output>", "<facts><PROJECT_RULES>\n* Validate release manifests before publishing.\n</PROJECT_RULES></facts>\n</output>");
        }
        reply
    }));
    let mut steps = Vec::new();
    for prompt in ["Inspect a.rs.", "Inspect b.rs.", "Inspect c.rs."] {
        steps.extend(turn(prompt));
    }
    steps.push(answer());
    runner.play(&steps).await;
    assert_clean(&runner);
    let conn = Connection::open(dir.join("context.db")).unwrap();
    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |row| row.get(0)).unwrap() };
    assert!(count("SELECT COUNT(*) FROM memory_pending_facts WHERE state='applied'") > 0);
    assert!(count("SELECT COUNT(*) FROM memory_placement WHERE memory_id > 1300") >= 3);
    assert!(count("SELECT COUNT(*) FROM memory_outbox") >= 3);
    measurements.collect(
        "two-pass-summary-and-admission",
        runner.provider().module().take_context_lock_samples(),
    );
    runner.play(&[Step::Wait { ms: 400_000 }, answer()]).await;
    assert_clean(&runner);
    assert!(
        !head_images(runner.host()).is_empty(),
        "fold must draw a mural"
    );
    measurements.collect(
        "mural-fold",
        runner.provider().module().take_context_lock_samples(),
    );
    let reports = runner.provider().module().run_upkeep().await;
    assert_eq!(reports.len(), 1);
    assert!(reports[0].1.memories_embedded > 0, "{reports:?}");
    assert!(
        matches!(
            reports[0].1.sweep,
            Some(mc_module::upkeep::Sweep::Indexed { inserted: 2, .. })
        ),
        "{reports:?}"
    );
    measurements.collect(
        "project-upkeep",
        runner.provider().module().take_context_lock_samples(),
    );
    let client = runner.provider().client.clone();
    drop(runner);
    let mut config = super::config("head", Kind::OpenAi, free());
    config.session.session = "one-pass".into();
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-test".into(),
        root: repo.to_string_lossy().into_owned(),
    });
    let mut runner = start_with_client(
        client,
        config,
        Settings {
            turn_two: false,
            ..settings
        },
        Some(dir.clone()),
        false,
        |_| {},
    )
    .await;
    let summarizer = mc_mock_runner::child::scripted_summarizer();
    runner.host().set_responder(Arc::new(move |settings, prompt| {
        let mut reply = summarizer(settings, prompt);
        reply.text = reply.text.replace("</output>", "<facts><PROJECT_RULES>\n* Validate release manifests before publishing.\n</PROJECT_RULES></facts>\n</output>");
        reply
    }));
    let mut steps = Vec::new();
    for prompt in ["Inspect d.rs.", "Inspect e.rs.", "Inspect f.rs."] {
        steps.extend(turn(prompt));
    }
    steps.push(answer());
    runner.play(&steps).await;
    assert_clean(&runner);
    assert_eq!(count("SELECT COUNT(*) FROM memories WHERE content='Validate release manifests before publishing.'"), 1);
    measurements.collect(
        "one-pass-summary-promotion",
        runner.provider().module().take_context_lock_samples(),
    );
    measurements.check();
    drop(runner);
    drop(conn);
    std::fs::remove_dir_all(dir).unwrap();
}
