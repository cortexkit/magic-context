use std::path::{Path, PathBuf};

use super::*;

fn required(name: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| panic!("{name} is required; run scripts/rehearsal-run.sh"))
}

fn measure(key: &str, value: impl std::fmt::Display) {
    eprintln!("REHEARSAL {key}={value}");
}

/// Fetching through the mock proves both reserved modules have registered,
/// without warming a session or timing a retried Setup as if it were one call.
async fn registered(stack: &Stack) {
    let consumer = SubcConsumer::connect(&stack.connection_file, ConsumerOptions::default())
        .await
        .expect("connect to the private daemon");
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        let reply = consumer
            .call(
                RouteTarget::ManagementSurface {
                    module_id: RUNNER.into(),
                },
                BindIdentity::new("mock", "rehearsal-registration"),
                wire::encode(
                    MOCK_FETCH,
                    &FetchRequest {
                        name: "role.describe".into(),
                        arguments: json!({}),
                        declare_role: true,
                    },
                ),
                CallOptions {
                    timeout: Duration::from_secs(5),
                    ..CallOptions::default()
                },
            )
            .await;
        if let Ok(bytes) = reply {
            if matches!(
                serde_json::from_slice::<FetchAnswer>(&bytes),
                Ok(FetchAnswer::Reply(_))
            ) {
                return;
            }
        }
        assert!(
            Instant::now() < deadline,
            "rehearsal modules did not register"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn output(turn: usize, tool: &str) -> String {
    (0..60).map(|line| format!(
        "src/session_{turn}.rs:{line}: {tool}: validate config, retain project memory, publish durable history; row={line:04}\n"
    )).collect()
}

pub(super) async fn run() {
    // Read HOME before spawn replaces it for the daemon and its children. No
    // process may start until the supplied data home passes the live-store fence.
    let original_home = PathBuf::from(required("HOME"));
    let data = data_home(
        &PathBuf::from(required("MC_REHEARSAL_DATA_HOME")),
        &original_home,
    )
    .unwrap_or_else(|error| panic!("{error}"));
    let module = required_binary("MC_REHEARSAL_CK_MC_BIN");
    let project = PathBuf::from(required("MC_REHEARSAL_PROJECT_ROOT"))
        .canonicalize()
        .expect("MC_REHEARSAL_PROJECT_ROOT must be an existing folder");
    assert!(
        project.is_dir(),
        "MC_REHEARSAL_PROJECT_ROOT must be a folder"
    );
    let project_id = required("MC_REHEARSAL_PROJECT_ID");
    let started = Instant::now();
    let stack = start_stack_with(&module, Some(&data), Some(&project), true);
    registered(&stack).await;
    measure(
        "modules_registered_ms",
        started.elapsed().as_secs_f64() * 1_000.0,
    );

    let mut cfg = config("head");
    cfg.session.session = format!(
        "rehearsal-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    cfg.model = ModelRef::new("anthropic", "claude-opus-5-5");
    cfg.kind = Kind::Anthropic;
    cfg.context_window = 1_000_000;
    cfg.output_reserve = 16_000;
    cfg.accepts_images = Some(true);
    cfg.model_latency_ms = 100;
    cfg.start_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    cfg.project = Some(mc_mock_runner::runner::Project {
        id: project_id,
        root: project.to_string_lossy().into_owned(),
    });
    let session = cfg.session.clone();
    let mut steps = Vec::new();
    for turn in 0..8 {
        steps.push(Step::User { text: format!("Inspect the session implementation, step {}. Explain the next change and its tests.", turn + 1) });
        let mut tools = vec![
            ToolCall::ok(
                "read",
                json!({"path":format!("src/session_{turn}.rs")}),
                output(turn, "read"),
            ),
            ToolCall::ok(
                "bash",
                json!({"command":format!("git diff -- src/session_{turn}.rs")}),
                output(turn, "diff"),
            ),
        ];
        if turn == 2 {
            tools.push(ToolCall::ok(
                "ctx_search",
                json!({"query":"context", "limit":10}),
                "",
            ));
        }
        if turn == 4 {
            tools.push(ToolCall::ok("ctx_note", json!({"action":"write", "content":"Rehearsal follow-up: inspect context publication latency before enabling the staged binary."}), ""));
        }
        steps.extend([
            Step::Model(Turn {
                text: Some("Inspecting the implementation and the working diff.".into()),
                tools,
                output_tokens: 40,
                ..Turn::default()
            }),
            answer(),
        ]);
    }
    steps.push(Step::Await {
        condition: AwaitCondition::ChildRuns { count: 1 },
        timeout_ms: START_TIMEOUT.as_millis() as u64,
    });
    // Simulate an expired cache so published history can refresh the head on a
    // genuine bust, rather than requiring a summary to break a cached prefix.
    steps.extend([Step::Wait { ms: 400_000 }, answer(), answer()]);
    let report = play(&stack, &PlayRequest { config: cfg, steps }).await;
    print_report(&report);
    app_read(&stack, &session).await;
}

fn memory_count(head: &str) -> usize {
    let block = head
        .split_once("<project-memory>")
        .and_then(|(_, rest)| rest.split_once("</project-memory>"))
        .map_or("", |(block, _)| block);
    block
        .lines()
        .filter_map(|line| {
            let line = line.strip_prefix('#')?;
            let digits: String = line.chars().take_while(char::is_ascii_digit).collect();
            let rest = &line[digits.len()..];
            (rest.starts_with(':') || rest.starts_with(" ["))
                .then(|| digits.parse::<u64>().ok())
                .flatten()
        })
        .collect::<std::collections::BTreeSet<_>>()
        .len()
}

fn search_hits(output: &str) -> Option<usize> {
    if output.starts_with("No results found") || output.starts_with("No hidden results found") {
        return Some(0);
    }
    output
        .strip_prefix("Found ")?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

fn print_report(report: &Report) {
    measure("model_errors", report.model_errors.len());
    measure("call_errors", report.call_errors.len());
    measure("refusals", report.refusals.len());
    measure("view_refusals", report.view_refusals.len());
    // Error text is JSON on one line, so a failed operation stays diagnosable
    // without dumping private memories or the contents of the copied store.
    measure(
        "errors",
        serde_json::to_string(&json!({
            "model": report.model_errors, "calls": report.call_errors,
            "refusals": report.refusals, "views": report.view_refusals,
        }))
        .unwrap(),
    );
    let observed = report
        .observations
        .as_ref()
        .expect("mock runner must support MC_MOCK_OBSERVE=1; rebuild its staged binary");
    // The whole observation set, including every view's edit lines, for
    // reading what each publication changed.
    if let Some(path) = std::env::var_os("MC_REHEARSAL_OBSERVATIONS") {
        std::fs::write(&path, serde_json::to_vec_pretty(observed).unwrap())
            .expect("MC_REHEARSAL_OBSERVATIONS names a writable file");
    }
    let setup = observed.setups.first().expect("no Setup observation");
    measure("setup_ms", setup.elapsed_ms);
    measure("setup_answer", &setup.answer);
    assert_eq!(
        setup.answer,
        serde_json::to_value(cortexkit_role_compaction::setup::SetupAnswer::Ready).unwrap(),
        "Setup did not answer ready"
    );
    // Publication times use Runner's real start as their origin, not Step::Wait's
    // simulated clock. Keep versions in the keys so every refresh is visible.
    for view in &observed.views {
        measure(
            &format!("view_{}_published_ms", view.version),
            view.published_ms,
        );
    }
    let first = observed.views.first().expect("no first view arrived");
    measure("first_view_ms", first.published_ms);
    let head = first.inserted_text.join("\n");
    let memories = memory_count(&head);
    measure(
        "first_view_history_head_bytes",
        first.inserted_text.iter().map(String::len).sum::<usize>(),
    );
    measure("first_view_memories", memories);
    measure("first_view_has_mural", first.image_count > 0);
    assert!(
        memories > 0,
        "the head shows no memories from the supplied project's real store"
    );
    for tool in &observed.tools {
        if tool.name == "ctx_search" {
            measure("ctx_search_ms", tool.elapsed_ms);
            measure(
                "ctx_search_hits",
                search_hits(&tool.output).map_or_else(|| "unavailable".into(), |n| n.to_string()),
            );
        }
        if tool.name == "ctx_note" {
            measure("ctx_note_ms", tool.elapsed_ms);
            measure("ctx_note_reply_bytes", tool.output.len());
        }
    }
    measure("summary_runs", observed.children.len());
    for (index, child) in observed.children.iter().enumerate() {
        measure(&format!("summary_run_{}_ms", index + 1), child.elapsed_ms);
    }
    if let Some(child) = observed.children.first() {
        if let Some(refresh) = observed
            .views
            .iter()
            .find(|view| view.published_ms > child.started_ms)
        {
            measure(
                "summary_to_head_refresh_ms",
                refresh.published_ms - child.started_ms,
            );
        }
    }
}

async fn app_read(stack: &Stack, session: &SessionRef) {
    let consumer = SubcConsumer::connect(&stack.connection_file, ConsumerOptions::default())
        .await
        .expect("app connection");
    for section in ["meta", "token_breakdown"] {
        let started = Instant::now();
        let reply = consumer.call(
            RouteTarget::InternalService {
                module_id: PROVIDER.into(),
                service_id: "mc-app-read".into(),
            },
            BindIdentity::new("rehearsal-app", "operator"),
            serde_json::to_vec(&json!({"method":"session_data.read", "params":{"session":session, "section":section}})).unwrap(),
            CallOptions { timeout: Duration::from_secs(60), ..CallOptions::default() },
        ).await.expect("session_data.read must answer over the app-read route");
        measure(
            &format!("app_read_{section}_ms"),
            started.elapsed().as_secs_f64() * 1_000.0,
        );
        measure(&format!("app_read_{section}_reply_bytes"), reply.len());
        let value: Value = serde_json::from_slice(&reply).expect("app reply JSON");
        measure(
            &format!("app_read_{section}_state"),
            &value["result"]["state"],
        );
    }
}

#[test]
fn rehearsal_report_counts_only_project_memories_and_search_results() {
    assert_eq!(memory_count("#1: docs\n<user-profile>\n#2: user\n</user-profile>\n<project-memory>\n<rules>\n#12: rule\n#12: repeated\n#23 [shared]: shared rule\n  #77: continuation\n</rules>\n</project-memory>"), 2);
    assert_eq!(
        search_hits("Found 10 results for \"context\":\n\n..."),
        Some(10)
    );
    assert_eq!(
        search_hits("No hidden results found for \"context\"."),
        Some(0)
    );
    assert_eq!(search_hits("failed to read search index"), None);
}

/// Resolve the copy before starting any child. Checking canonical paths also
/// rejects a harmless-looking symlink that leads back into the user's stores.
fn data_home(data: &Path, original_home: &Path) -> Result<PathBuf, String> {
    let data = data
        .canonicalize()
        .map_err(|error| format!("MC_REHEARSAL_DATA_HOME must be an existing folder: {error}"))?;
    let home = original_home
        .canonicalize()
        .map_err(|error| format!("cannot resolve original HOME for the safety check: {error}"))?;
    let live = home.join(".local/share");
    let live = live.canonicalize().unwrap_or(live);
    let refuse = |path: &Path| {
        if path.starts_with(&live) {
            Err(format!(
                "refusing MC_REHEARSAL_DATA_HOME under the real user's ~/.local/share: {}",
                path.display()
            ))
        } else {
            Ok(())
        }
    };
    refuse(&data)?;
    if !data.is_dir() {
        return Err("MC_REHEARSAL_DATA_HOME must be an existing folder".into());
    }
    let db = data.join("cortexkit/magic-context/context.db");
    let db = db.canonicalize().map_err(|error| {
        format!(
            "MC_REHEARSAL_DATA_HOME has no context.db at {}: {error}",
            db.display()
        )
    })?;
    refuse(&db)?;
    if !db.is_file() {
        return Err("MC_REHEARSAL_DATA_HOME context.db is not a file".into());
    }
    Ok(data)
}

#[test]
fn rehearsal_data_home_refuses_a_live_looking_path_before_opening_a_store() {
    let temp = tempfile::tempdir().unwrap();
    let fake_home = temp.path().join("home");
    let live = fake_home.join(".local/share/cortexkit/magic-context");
    std::fs::create_dir_all(&live).unwrap();
    let error = data_home(&live, &fake_home).unwrap_err();
    assert!(error.contains("refusing"), "{error}");
    assert!(error.contains("~/.local/share"), "{error}");
}

#[test]
fn rehearsal_data_home_requires_the_copied_context_db() {
    let temp = tempfile::tempdir().unwrap();
    let fake_home = temp.path().join("home");
    let copy = temp.path().join("copy");
    std::fs::create_dir_all(&fake_home).unwrap();
    std::fs::create_dir_all(&copy).unwrap();
    assert!(data_home(&copy, &fake_home)
        .unwrap_err()
        .contains("no context.db"));
    let db = copy.join("cortexkit/magic-context/context.db");
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    std::fs::write(&db, []).unwrap();
    assert_eq!(
        data_home(&copy, &fake_home).unwrap(),
        copy.canonicalize().unwrap()
    );
}

#[cfg(unix)]
#[test]
fn rehearsal_data_home_refuses_symlinks_into_the_live_looking_tree() {
    let temp = tempfile::tempdir().unwrap();
    let fake_home = temp.path().join("home");
    let live = fake_home.join(".local/share");
    std::fs::create_dir_all(&live).unwrap();
    let alias = temp.path().join("copy");
    std::os::unix::fs::symlink(&live, &alias).unwrap();
    assert!(data_home(&alias, &fake_home)
        .unwrap_err()
        .contains("refusing"));
}
