//! The production executor over a Broca transport: a classify run dispatched by
//! the real `Dispatcher` and `DreamExecutor`, with the fake Broca as its port.

use super::*;
use crate::dream_dispatch::dispatcher::{DispatchOutcome, Dispatcher};
use crate::dream_dispatch::executor::{BrocaPorts, DreamExecutor, Transport};
use mc_store::dream_scheduler::schedules::RunStatus as ScheduleStatus;
use mc_store::McStore;

impl BrocaPorts for FakeBroca {
    type Port = FakeBroca;
    fn port(&self) -> FakeBroca {
        self.clone()
    }
}

struct Wall;
impl Clock for Wall {
    fn now_ms(&self) -> i64 {
        crate::now_ms()
    }
}

struct BrocaRun {
    _root: tempfile::TempDir,
    store: Arc<McStore>,
    broca: FakeBroca,
    outcome: DispatchOutcome,
}

fn classify_text() -> &'static str {
    Box::leak(
        format!(
            "<classify>{}</classify>",
            (1..=10)
                .map(|id| format!(
                    "<memory id=\"{id}\" importance=\"80\" scope=\"project\" shareable=\"false\" />"
                ))
                .collect::<String>()
        )
        .into_boxed_str(),
    )
}

/// One manual classify run through the production executor with the user's
/// configured Broca runner, against a fake Broca with `capabilities`.
async fn classify_through_broca(capabilities: &[&str], steps: Vec<Step>) -> BrocaRun {
    through_broca(TaskName::Classify, capabilities, steps, None, |store, project| {
        store
            .with_context_conn_for_test(|tx| {
                for id in 1..=10 {
                    let content = format!("ARCHITECTURE entry {id} describes one durable fact.");
                    tx.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,source_session_id,first_seen_at,created_at,updated_at,last_seen_at,metadata_json) VALUES (?1,?2,'ARCHITECTURE',?3,?4,'source',1,1,1,1,'{}')",
                        rusqlite::params![id, project, content, mc_store::compute_normalized_memory_hash(&content)])?;
                }
                Ok(())
            })
            .unwrap();
    })
    .await
}

/// A committed git checkout at `<root>/repo`, the directory the run works in.
/// `src/cache.rs` holds the code the memories make claims about.
fn fixture_repository(root: &std::path::Path) -> std::path::PathBuf {
    let repo = root.join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(
        repo.join("src/cache.rs"),
        "/// Drops the least recently used entry when the cache is full.\npub fn evict_lru() {}\n",
    )
    .unwrap();
    std::fs::write(repo.join("src/other.rs"), "pub fn unrelated() {}\n").unwrap();
    let git = |args: &[&str]| {
        assert!(std::process::Command::new("git")
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid"
            ])
            .args(args)
            .current_dir(&repo)
            .status()
            .unwrap()
            .success());
    };
    git(&["init", "--quiet"]);
    git(&["add", "src"]);
    git(&["commit", "--quiet", "-m", "fixture"]);
    repo.canonicalize().unwrap()
}

/// One manual run of `task` through the production executor with the user's
/// configured Broca runner, against a fake Broca with `capabilities`. With
/// `repository`, the run works in a committed fixture checkout under the root and
/// the fake serves AFT's read tools from it; otherwise in the root itself.
async fn through_broca(
    task: TaskName,
    capabilities: &[&str],
    steps: Vec<Step>,
    repository: Option<ComposeFn>,
    seed: impl FnOnce(&McStore, &str),
) -> BrocaRun {
    let base = std::env::temp_dir().join("magic-context/i5-stage-e");
    std::fs::create_dir_all(&base).unwrap();
    let root = tempfile::tempdir_in(base).unwrap();
    let directory = if repository.is_some() {
        fixture_repository(root.path())
    } else {
        root.path().canonicalize().unwrap()
    };
    let project = directory.to_string_lossy().into_owned();
    let store = Arc::new(
        McStore::open_for_test(&crate::dev_descriptor_at(root.path().to_str().unwrap())).unwrap(),
    );
    seed(&store, &project);
    let scheduler =
        Arc::new(SqliteDreamScheduler::open(root.path().join("scheduler.db"), true).unwrap());
    let handler = Arc::new(McHandler::new());
    let broca = FakeBroca {
        state: Arc::new(Mutex::new(State {
            describe: describe(capabilities, 1_000_000, 600_000),
            steps,
            compose: repository,
            ..State::default()
        })),
        handler: handler.clone(),
        directory: directory.clone(),
    };
    let mut dispatcher = Dispatcher {
        store: store.clone(),
        scheduler: scheduler.clone(),
        scope: StoreScope {
            project: ProjectId(project),
            session: SessionId("parent".into()),
            generation: Generation(1),
        },
        config: Arc::new(CapturedConfig {
            activated: true,
            // The user named Broca as the dreamer runner.
            route: McModuleConfig {
                rust_background_enabled: true,
                dreamer_runner: Some(HistorianRunnerKind::Broca),
                ..Default::default()
            },
            effective: json!({"dreamer": {"claude-code": {"model": "provider/model"},
                "tasks": Value::Object(Map::from_iter([(task.as_str().to_owned(),
                    json!({"schedule": "* * * * *"}))]))}}),
            harness: "claude-code".into(),
            directory,
        }),
        clock: Arc::new(Wall),
        executor: DreamExecutor::new(
            store.clone(),
            scheduler,
            Transport::Broca {
                ports: broca.clone(),
                routes: handler.broca_dream_tools(),
                module_id: "magic-context".into(),
            },
            &[task],
            crate::dream_dispatch::dispatcher::OPERATIONAL_TASKS,
        ),
    };
    let config = TaskConfig {
        task,
        schedule: "* * * * *".into(),
        has_input: true,
        legacy_last_run_at: None,
    };
    let outcome = bounded(dispatcher.manual(
        &config,
        "command",
        // map and verify stop before a batch when less than four minutes remain.
        Duration::from_secs(30 * 60),
        Cancellation::default(),
    ))
    .await;
    BrocaRun {
        _root: root,
        store,
        broca,
        outcome,
    }
}

fn classified(store: &McStore) -> i64 {
    store
        .with_context_read(|db| {
            db.query_row(
                "SELECT COUNT(*) FROM memories WHERE classified_at IS NOT NULL",
                [],
                |r| r.get(0),
            )
        })
        .unwrap()
}

fn input_cap(run: &BrocaRun) -> Option<u64> {
    let sends = run.broca.ops("session.send");
    assert!(
        !sends.is_empty(),
        "no send: {:?} log {:?}",
        run.outcome,
        run.broca.state().log
    );
    sends[0]["budget"]["max_input_tokens"].as_u64()
}

#[tokio::test]
async fn broca_executor_sends_the_cap_only_to_a_runner_that_advertises_it() {
    let mut capped = BASE.to_vec();
    capped.push("input_token_cap");
    let with_cap = classify_through_broca(&capped, vec![answer(classify_text())]).await;
    assert_eq!(
        with_cap.outcome,
        DispatchOutcome::Finished(ScheduleStatus::Completed)
    );
    // The whole classify task budget is the cap: nothing was spent before.
    assert_eq!(input_cap(&with_cap), Some(2_500_000));
    assert_eq!(classified(&with_cap.store), 10);

    let without = classify_through_broca(BASE, vec![answer(classify_text())]).await;
    assert_eq!(
        without.outcome,
        DispatchOutcome::Finished(ScheduleStatus::Completed)
    );
    assert_eq!(input_cap(&without), None);
    assert!(without.broca.ops("session.send")[0].get("budget").is_none());
    assert_eq!(classified(&without.store), 10);
}

#[tokio::test]
async fn broca_budget_exhausted_ends_the_run_cleanly_without_an_effect() {
    let mut capped = BASE.to_vec();
    capped.push("input_token_cap");
    let mut over = answer(classify_text());
    over.input = 3_000_000;
    let run = classify_through_broca(&capped, vec![over]).await;
    // The run finishes (failed, recorded), it is not aborted or left leased.
    assert_eq!(
        run.outcome,
        DispatchOutcome::Finished(ScheduleStatus::Failed)
    );
    assert_eq!(classified(&run.store), 0);
    let state = run.broca.state();
    assert_eq!(
        state.run.as_ref().unwrap().terminal.as_ref().unwrap().state,
        "budget_exhausted"
    );
    assert!(!state.released.is_empty(), "the Broca session was released");
    drop(state);
    // The domain lease was released: TypeScript can take the next run.
    assert!(run
        .store
        .acquire_dream_domain(
            &TaskName::Classify.lease_key(&run.store_project()),
            "typescript",
            crate::now_ms()
        )
        .unwrap()
        .is_some());
}

impl BrocaRun {
    fn store_project(&self) -> String {
        self._root
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    fn query_strings(&self, sql: &str) -> Vec<String> {
        self.store
            .with_context_read(|db| {
                db.prepare(sql)?
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
    }

    /// The single send's file-tool plan item: what Broca was asked to admit.
    fn file_item(&self) -> Value {
        let sends = self.broca.ops("session.send");
        assert_eq!(sends.len(), 1, "{:?}", self.outcome);
        sends[0]["plan"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["provider"] == FILE_TOOL_PROVIDER)
            .cloned()
            .expect("a file-tool plan item")
    }
}

fn insert_memory(tx: &rusqlite::Transaction<'_>, id: i64, project: &str, content: &str) {
    tx.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,source_session_id,first_seen_at,created_at,updated_at,last_seen_at,metadata_json) VALUES (?1,?2,'ARCHITECTURE',?3,?4,'source',1,1,1,1,'{}')",
        rusqlite::params![id, project, content, mc_store::compute_normalized_memory_hash(content)]).unwrap();
}

/// The content the fake read from `path`, if a `read` of it succeeded.
fn read_content<'a>(results: &'a [(String, Value)], path: &str) -> Option<&'a str> {
    results
        .iter()
        .filter(|(tool, result)| tool == "read" && result["path"] == path)
        .find_map(|(_, result)| result["content"].as_str())
}

/// map-memories runs through the production executor over a Broca runner that
/// carries AFT's read tools: the child greps and reads the fixture repository,
/// its answer names the file it found the claim in, and that mapping lands in the
/// store. The answer is built from what the reads returned, so without real reads
/// of the checkout no file would be mapped.
#[tokio::test]
async fn broca_map_reads_the_repository_and_its_mapping_lands() {
    let compose: ComposeFn = Box::new(|results| {
        let found: Vec<String> = results
            .iter()
            .filter(|(tool, _)| tool == "grep")
            .flat_map(|(_, r)| r["files"].as_array().cloned().unwrap_or_default())
            .filter_map(|file| file.as_str().map(str::to_owned))
            .filter(|file| read_content(results, file).is_some_and(|c| c.contains("evict_lru")))
            .collect();
        format!(
            "<mappings><memory id=\"1\" files=\"{}\"/><memory id=\"2\" independent=\"true\"/></mappings>",
            found.join(",")
        )
    });
    let run = through_broca(
        TaskName::Map,
        BASE,
        vec![
            step(10, vec![("grep", json!({"pattern": "evict_lru"}))]),
            step(10, vec![("read", json!({"filePath": "src/cache.rs"}))]),
            Step {
                input: 1,
                ..Step::default()
            },
        ],
        Some(compose),
        |store, project| {
            store
                .with_context_conn_for_test(|tx| {
                    insert_memory(
                        tx,
                        1,
                        project,
                        "The cache drops its least recently used entry in evict_lru.",
                    );
                    insert_memory(
                        tx,
                        2,
                        project,
                        "Always run the formatter before committing.",
                    );
                    Ok(())
                })
                .unwrap();
        },
    )
    .await;
    assert_eq!(
        run.outcome,
        DispatchOutcome::Finished(ScheduleStatus::Completed)
    );
    // Broca was asked to admit AFT's read tools rooted at the checkout.
    let item = run.file_item();
    assert_eq!(
        item["params"]["tools"],
        json!(DreamRole::MemoryMapper.tools())
    );
    assert_eq!(item["params"]["root"], json!(run.store_project() + "/repo"));
    // The reads really hit the fixture checkout.
    let results = run.broca.state().results.clone();
    assert_eq!(results[0].1["files"], json!(["src/cache.rs"]));
    assert!(read_content(&results, "src/cache.rs")
        .unwrap()
        .contains("pub fn evict_lru"));
    assert_eq!(
        run.query_strings("SELECT file_path FROM memory_verifications WHERE memory_id=1"),
        ["src/cache.rs"]
    );
    // The file-independent memory gets the empty-path marker, not a file.
    assert_eq!(
        run.query_strings("SELECT file_path FROM memory_verifications WHERE memory_id=2"),
        [""]
    );
}

/// verify and verify-broad run through the production executor over a Broca
/// runner that carries AFT's read tools: the child reads the mapped file, a claim
/// the source still backs is verified and one it no longer backs is archived.
#[tokio::test]
async fn broca_verify_reads_the_repository_and_its_verdicts_land() {
    for task in [TaskName::Verify, TaskName::VerifyBroad] {
        let compose: ComposeFn = Box::new(|results| {
            let source = read_content(results, "src/cache.rs").unwrap_or_default();
            let verdict = |id: i64, symbol: &str| {
                if source.contains(symbol) {
                    format!("<verified id=\"{id}\" files=\"src/cache.rs\"/>")
                } else {
                    format!("<archive id=\"{id}\" reason=\"{symbol} is not in src/cache.rs\"/>")
                }
            };
            format!(
                "<verify>{}{}</verify>",
                verdict(1, "evict_lru"),
                verdict(2, "flush_all")
            )
        });
        let run = through_broca(
            task,
            BASE,
            vec![
                step(10, vec![("read", json!({"filePath": "src/cache.rs"}))]),
                Step {
                    input: 1,
                    ..Step::default()
                },
            ],
            Some(compose),
            |store, project| {
                store
                    .with_context_conn_for_test(|tx| {
                        insert_memory(tx, 1, project, "evict_lru drops the least recently used cache entry.");
                        insert_memory(tx, 2, project, "flush_all empties the whole cache at once.");
                        for id in [1, 2] {
                            tx.execute("INSERT INTO memory_verifications(memory_id,file_path,verified_at,mapped_at,mapping_origin) VALUES(?1,'src/cache.rs',0,1,'mapper')", [id])?;
                        }
                        Ok(())
                    })
                    .unwrap();
            },
        )
        .await;
        assert_eq!(
            run.outcome,
            DispatchOutcome::Finished(ScheduleStatus::Completed),
            "{task:?}"
        );
        let item = run.file_item();
        assert_eq!(
            item["params"]["tools"],
            json!(DreamRole::MemoryMapper.tools())
        );
        let results = run.broca.state().results.clone();
        assert!(read_content(&results, "src/cache.rs")
            .unwrap()
            .contains("pub fn evict_lru"));
        assert_eq!(
            run.query_strings("SELECT status FROM memories WHERE id IN (1,2) ORDER BY id"),
            ["active", "archived"],
            "{task:?}"
        );
        assert_eq!(
            run.query_strings(
                "SELECT CAST(id AS TEXT) FROM memories WHERE verified_at IS NOT NULL ORDER BY id"
            ),
            ["1"],
            "{task:?}"
        );
    }
}

/// The curate task runs through the production executor over a Broca runner: the
/// child's `ctx_memory` update reaches the task router, the edit bumps the
/// memory's revision, and the audited history keeps the prior text.
#[tokio::test]
async fn broca_curate_edit_runs_through_the_task_router_with_history_and_revisions() {
    let update = json!({"action": "update", "ids": [1],
        "content": "ARCHITECTURE entry 1 states its durable fact in clearer present-tense words."});
    let run = through_broca(
        TaskName::Curate,
        BASE,
        vec![
            step(10, vec![("ctx_memory", update)]),
            answer("Updated one memory."),
        ],
        None,
        |store, project| {
            store
                .with_context_conn_for_test(|tx| {
                    for id in 1..=10 {
                        let content =
                            format!("ARCHITECTURE entry {id} describes one durable fact.");
                        insert_memory(tx, id, project, &content);
                    }
                    Ok(())
                })
                .unwrap();
        },
    )
    .await;
    assert_eq!(
        run.outcome,
        DispatchOutcome::Finished(ScheduleStatus::Completed),
        "{:?}",
        run.broca.state().results
    );
    let scalar = |sql: &str| -> i64 {
        run.store
            .with_context_read(|db| db.query_row(sql, [], |r| r.get(0)))
            .unwrap()
    };
    assert_eq!(scalar("SELECT revision FROM memories WHERE id=1"), 2);
    assert_eq!(
        scalar("SELECT COUNT(*) FROM memory_history WHERE memory_id=1 AND revision=1 AND previous_text='ARCHITECTURE entry 1 describes one durable fact.' AND json_extract(before_json,'$.snapshot.content')=previous_text AND json_extract(after_json,'$.snapshot.revision')=2"),
        1
    );
    assert_eq!(scalar("SELECT COUNT(*) FROM memory_journal"), 1);
}

/// review-user-memories runs through the production executor over a Broca
/// runner and commits its verdict: promote, update, dismiss and consume.
#[tokio::test]
async fn broca_user_memory_review_commits_its_verdict() {
    let verdict = r#"{"promote":[{"content":"Prefers bounded checks","candidate_ids":[1,2]}],"update_existing":[{"memory_id":1,"content":"Prefers concise reports","candidate_ids":[3]}],"dismiss_existing":[{"memory_id":2,"reason":"unsupported"}],"consume_candidate_ids":[1,2,3]}"#;
    let run = through_broca(
        TaskName::ReviewUserMemories,
        BASE,
        vec![answer(verdict)],
        None,
        |store, _project| {
            store
                .with_context_conn_for_test(|tx| {
                    // Three candidates reach the default promotion threshold of 3.
                    tx.execute_batch(
                        "INSERT INTO user_memory_candidates(id,content,session_id,created_at,source_compartment_start,source_compartment_end) VALUES
                            (1,'Prefers bounded checks','source-1',strftime('%s','now')*1000,10,20),
                            (2,'Prefers bounded checks','source-2',strftime('%s','now')*1000,10,20),
                            (3,'Prefers bounded checks','source-3',strftime('%s','now')*1000,10,20);
                         INSERT INTO user_memories(id,content,status,promoted_at,created_at,updated_at) VALUES
                            (1,'Prefers long reports','active',1,1,1),(2,'Likes guesses','active',1,1,1);",
                    )
                })
                .unwrap();
        },
    )
    .await;
    assert_eq!(
        run.outcome,
        DispatchOutcome::Finished(ScheduleStatus::Completed)
    );
    let scalar = |sql: &str| -> i64 {
        run.store
            .with_context_read(|db| db.query_row(sql, [], |r| r.get(0)))
            .unwrap()
    };
    assert_eq!(scalar("SELECT COUNT(*) FROM user_memory_candidates"), 0);
    assert_eq!(
        scalar("SELECT COUNT(*) FROM user_memories WHERE id=3 AND content='Prefers bounded checks' AND status='active'"),
        1
    );
    assert_eq!(
        scalar(
            "SELECT COUNT(*) FROM user_memories WHERE id=1 AND content='Prefers concise reports'"
        ),
        1
    );
    assert_eq!(
        scalar("SELECT COUNT(*) FROM user_memories WHERE id=2 AND status='dismissed'"),
        1
    );
    assert_eq!(
        scalar("SELECT COUNT(*) FROM memory_journal WHERE operation='user_profile_review'"),
        1
    );
}
