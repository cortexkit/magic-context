//! The scenarios over the real wire: a throwaway subc daemon, ck-mc and the
//! mock runner as modules of it, and a test consumer that asks the mock
//! runner to play a scenario. What the in-process scenarios cannot see shows
//! up here: frame limits, calls that cross between the two modules while
//! each waits on the other, and timing, since ck-mc handles notices while the
//! runner's next request is already out.
//!
//! Needs two binaries the workspace does not build: the daemon
//! (`MC_TEST_CK_SUBC_BIN`) and the mock runner (`MC_TEST_MOCK_RUNNER_BIN`).
//! `scripts/wire-gate.sh` builds both and runs this suite. The tests are
//! ignored by default; once run, a missing binary fails them.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use cortexkit_role_compaction::read::SessionRef;
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::ModelRef;
use cortexkit_role_compaction::wire;
use mc_mock_runner::model::Kind;
use mc_mock_runner::runner::{Report, SessionConfig};
use mc_mock_runner::script::{AwaitCondition, Step, ToolCall, Turn};
use mc_mock_runner::subc::{FetchAnswer, FetchRequest, PlayRequest, MOCK_FETCH, MOCK_PLAY};
use serde_json::{json, Value};
use subc_client_rs::{CallOptions, ConsumerOptions, SubcConsumer};
use subc_protocol::{BindIdentity, RouteTarget, SUBC_LAUNCH_NONCE_ENV, SUBC_MODULE_ID_ENV};

const PROVIDER: &str = "magic-context";
const RUNNER: &str = "mock-runner";
/// Read by a launched child to find its launch nonce; a test-launched module
/// must not inherit one.
const LAUNCH_NONCE_FD_ENV: &str = "SUBC_LAUNCH_NONCE_FD";
const START_TIMEOUT: Duration = Duration::from_secs(60);

#[path = "support/rehearsal.rs"]
mod rehearsal;

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A process the test started; killed when the test ends.
struct Process(Child);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The test's private directories. Kept when the test fails, for the logs.
struct Root(PathBuf);

impl Drop for Root {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

fn required_binary(env: &str) -> PathBuf {
    let path = std::env::var_os(env)
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("{env} must name the binary; scripts/wire-gate.sh sets it"));
    assert!(path.is_file(), "{env} names no file: {}", path.display());
    path
}

/// A copy of `binary` named `ckdev-<name>`, so no test process looks like a
/// fleet module in a process list.
fn dev_copy(binary: &Path, root: &Path, name: &str) -> PathBuf {
    let target = root.join(format!("ckdev-{name}"));
    fs::copy(binary, &target).unwrap();
    target
}

/// Run `program` with the test's directories and none of the launch
/// variables a module under a real daemon would inherit.
fn spawn(
    program: &Path,
    args: &[&std::ffi::OsStr],
    root: &Path,
    data_home: &Path,
    env: &[(&str, &str)],
    label: &'static str,
) -> Process {
    let mut command = Command::new(program);
    command
        .args(args)
        .env("XDG_RUNTIME_DIR", root.join("runtime"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_DATA_HOME", data_home)
        .env("HOME", root.join("config"))
        .env_remove("MAGIC_CONTEXT_DB")
        .env_remove("MAGIC_CONTEXT_MODE3_STORE")
        .env_remove("MAGIC_CONTEXT_STORAGE_DIR")
        .env_remove("MAGIC_CONTEXT_TEST_DATA_DIR")
        .env_remove("MAGIC_CONTEXT_CONFIG_PATH")
        .env_remove(SUBC_MODULE_ID_ENV)
        .env_remove(SUBC_LAUNCH_NONCE_ENV)
        .env_remove(LAUNCH_NONCE_FD_ENV)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    for (name, value) in env {
        command.env(name, value);
    }
    let mut child = command
        .spawn()
        .unwrap_or_else(|error| panic!("failed to start {}: {error}", program.display()));
    // An undrained pipe blocks the child once its buffer fills.
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::BufRead as _;
            for line in std::io::BufReader::new(stderr)
                .lines()
                .map_while(Result::ok)
            {
                eprintln!("{label}: {line}");
            }
        });
    }
    Process(child)
}

struct Stack {
    connection_file: PathBuf,
    /// A project folder a scenario may give its session.
    project_root: PathBuf,
    _processes: Vec<Process>,
    _root: Root,
}

fn start_stack() -> Stack {
    start_stack_with(Path::new(env!("CARGO_BIN_EXE_ck-mc")), None, None, false)
}

fn start_stack_with(
    module: &Path,
    data_home: Option<&Path>,
    project_root: Option<&Path>,
    observe: bool,
) -> Stack {
    let root = std::env::temp_dir().join(format!(
        "mc-wire-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    for dir in ["runtime", "config/cortexkit", "data"] {
        fs::create_dir_all(root.join(dir)).unwrap();
    }
    let daemon = dev_copy(&required_binary("MC_TEST_CK_SUBC_BIN"), &root, "subc");
    let runner = dev_copy(
        &required_binary("MC_TEST_MOCK_RUNNER_BIN"),
        &root,
        "mock-runner",
    );
    let module = dev_copy(module, &root, "mc");
    let connection_file = root.join("runtime/subc-connection.json");
    // ck-mc's context store, where summaries and memories live. A standalone
    // plugin creates it in production.
    let private_data = root.join("data");
    if data_home.is_none() {
        let context_db = private_data.join("cortexkit/magic-context/context.db");
        fs::create_dir_all(context_db.parent().unwrap()).unwrap();
        mc_module::context_db::ContextDb::create_for_tests(&context_db).unwrap();
    }
    let private_project = root.join("project");
    let project_root = project_root.unwrap_or(&private_project);
    if project_root == private_project {
        fs::create_dir_all(project_root).unwrap();
    }
    // The daemon launches both modules itself, as reserved modules. That is
    // what makes it attest each one to the other: a runner's routes reach
    // ck-mc only as an attested module, and ck-mc's reach the runner the
    // same way.
    let entry = |program: &Path, env: Value| {
        json!({
            "program": program,
            "args": ["--subc", connection_file],
            "env": env,
            "enabled": true,
            "reserved": true,
        })
    };
    fs::write(
        root.join("config/cortexkit/subc.jsonc"),
        json!({
            "version": 1,
            "modules": {
                PROVIDER: entry(&module, json!({})),
                RUNNER: entry(&runner, json!({
                    "MOCK_RUNNER_PROVIDER": PROVIDER,
                    "MC_MOCK_OBSERVE": if observe { "1" } else { "0" },
                })),
            },
        })
        .to_string(),
    )
    .unwrap();

    if data_home.is_some() {
        // A token threshold lets a short rehearsal exercise the historian even
        // with a million-token model window. These settings stay in the private
        // config directory, never in the supplied project or copied data home.
        fs::write(
            root.join("config/cortexkit/magic-context.json"),
            json!({
                "execute_threshold_tokens": {"default": 5_000},
                "protected_tokens": 4_000,
            })
            .to_string(),
        )
        .unwrap();
    }

    let processes = vec![spawn(
        &daemon,
        &[],
        &root,
        data_home.unwrap_or(&private_data),
        &[("SUBC_PORT", "0"), ("SUBC_CGROUP_PLACEMENT", "disabled")],
        "subc",
    )];
    let deadline = Instant::now() + START_TIMEOUT;
    while !connection_file.exists() {
        assert!(
            Instant::now() < deadline,
            "the daemon wrote no connection file"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    Stack {
        connection_file,
        project_root: project_root.to_path_buf(),
        _processes: processes,
        _root: Root(root),
    }
}

/// Ask the mock runner to play a scenario, waiting for both modules to
/// register first and for each step's notices to be processed before the next.
async fn play(stack: &Stack, request: &PlayRequest) -> Report {
    let request = PlayRequest {
        config: request.config.clone(),
        steps: request
            .steps
            .iter()
            .flat_map(|step| {
                [
                    step.clone(),
                    Step::Await {
                        condition: AwaitCondition::NoticesProcessed,
                        timeout_ms: START_TIMEOUT.as_millis() as u64,
                    },
                ]
            })
            .collect(),
    };
    let consumer = SubcConsumer::connect(&stack.connection_file, ConsumerOptions::default())
        .await
        .unwrap();
    let options = CallOptions {
        timeout: Duration::from_secs(300),
        ..CallOptions::default()
    };
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        let reply = consumer
            .call(
                RouteTarget::ManagementSurface {
                    module_id: RUNNER.into(),
                },
                BindIdentity::new("mock", "wire-test"),
                wire::encode(MOCK_PLAY, &request),
                options.clone(),
            )
            .await;
        match reply {
            Ok(bytes) => return serde_json::from_slice(&bytes).unwrap(),
            // Either module may still be registering, or ck-mc may not be
            // there yet when the runner's Setup goes out.
            Err(error) if Instant::now() < deadline => {
                eprintln!("waiting for the modules: {error:?}");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Err(error) => panic!("mock.play failed: {error:?}"),
        }
    }
}

fn free() -> ProviderRules {
    ProviderRules::new(SignedParts::None, EditCost::Suffix)
}

fn config(preset: &str) -> SessionConfig {
    SessionConfig {
        session: SessionRef::new(
            RUNNER,
            "mock",
            format!("wire-{}", COUNTER.fetch_add(1, Ordering::Relaxed)),
        ),
        preset: preset.into(),
        model: ModelRef::new("test", "test-model"),
        context_window: 40_000,
        output_reserve: 1_000,
        rules: free(),
        kind: Kind::OpenAi,
        cache_ttl_ms: 300_000,
        system_tokens: 500,
        tag_checkpoint: 0,
        moved_in: None,
        start_ms: 1_000_000,
        project: None,
        model_latency_ms: 0,
        templates: mc_module::nudges::templates(),
        accepts_images: None,
        view_anchor: true,
    }
}

fn read_file() -> Step {
    Step::Model(Turn {
        reasoning_tokens: Some(50),
        text: Some("Reading the next file.".into()),
        tools: vec![ToolCall::ok(
            "read",
            json!({"path": "a.rs"}),
            "x".repeat(28_000),
        )],
        output_tokens: 20,
        ..Turn::default()
    })
}

fn answer() -> Step {
    Step::Model(Turn {
        text: Some("Done.".into()),
        output_tokens: 5,
        ..Turn::default()
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs the daemon and mock runner binaries; run through scripts/wire-gate.sh"]
async fn ck_mc_refuses_a_route_from_a_caller_the_daemon_does_not_attest() {
    let stack = start_stack();
    // Make sure ck-mc is up: the mock runner's scenario reaches it.
    let _ = play(
        &stack,
        &PlayRequest {
            config: config("worker"),
            steps: vec![answer()],
        },
    )
    .await;
    // This test's own consumer is a direct key-holder, not a module the
    // daemon launched, so it cannot claim to be a runner. Its Setup names a
    // session through the route alone, and ck-mc refuses the route.
    let consumer = SubcConsumer::connect(&stack.connection_file, ConsumerOptions::default())
        .await
        .unwrap();
    let setup = json!({
        "preset": "worker",
        "model": {"provider": "test", "model": "test-model"},
        "context_window": 40_000,
        "output_reserve": 1_000,
        "rules": {"signed_reasoning": "none", "history_edit_cost": "suffix"},
        "now": 0,
    });
    let reply = consumer
        .call(
            RouteTarget::ToolProvider {
                module_id: PROVIDER.into(),
            },
            BindIdentity::new("mock", "forged"),
            wire::encode(cortexkit_role_compaction::ops::COMPACTION_SETUP, &setup),
            CallOptions {
                timeout: Duration::from_secs(30),
                ..CallOptions::default()
            },
        )
        .await;
    let error = format!("{:?}", reply.expect_err("an unattested caller was served"));
    assert!(error.contains("unattested_runner"), "{error}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs the daemon and mock runner binaries; run through scripts/wire-gate.sh"]
async fn a_worker_reduces_over_the_real_wire() {
    let stack = start_stack();
    let request = PlayRequest {
        config: config("worker"),
        steps: vec![
            Step::User {
                text: "Review the module.".into(),
            },
            read_file(),
            read_file(),
            Step::Model(Turn {
                text: Some("Those reads are done.".into()),
                tools: vec![ToolCall::ok("ctx_reduce", json!({"drop": "3,5"}), "")],
                output_tokens: 10,
                ..Turn::default()
            }),
            read_file(),
            read_file(),
            answer(),
            answer(),
            answer(),
            answer(),
        ],
    };
    let report = play(&stack, &request).await;
    assert!(report.model_errors.is_empty(), "{:?}", report.model_errors);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    assert!(
        report.view_refusals.is_empty(),
        "{:?}",
        report.view_refusals
    );
    assert!(report.call_errors.is_empty(), "{:?}", report.call_errors);
    // The drops landed as a view. When exactly depends on timing over the
    // wire; that it landed, once, does not.
    let views: std::collections::BTreeSet<_> = report
        .requests
        .iter()
        .filter_map(|record| record.view)
        .collect();
    assert_eq!(views.into_iter().collect::<Vec<_>>(), [1]);
    // Between views every request extends the previous one.
    for pair in report.requests.windows(2) {
        if pair[0].view == pair[1].view {
            assert_eq!(
                pair[1].usage.cache_read_tokens, pair[0].usage.prompt_tokens,
                "{pair:?}"
            );
        }
    }
}

/// A head summarizes over the real wire: the session's routes carry its
/// project from their scope, ck-mc publishes its own child scope for that
/// folder, picks a model through routing (the mock stands in for it), and
/// runs the summarizer in a child session the runner creates under that
/// scope.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs the daemon and mock runner binaries; run through scripts/wire-gate.sh"]
async fn a_head_summarizes_in_a_child_under_ck_mc_s_scope_over_the_real_wire() {
    let stack = start_stack();
    let mut config = config("head");
    config.context_window = 100_000;
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-wire".into(),
        root: stack.project_root.to_string_lossy().into_owned(),
    });
    let session = config.session.session.clone();
    let read = || {
        Step::Model(Turn {
            reasoning_tokens: Some(50),
            text: Some("Reading the next file.".into()),
            tools: vec![ToolCall::ok(
                "read",
                json!({"path": "a.rs"}),
                "x".repeat(48_000),
            )],
            output_tokens: 20,
            ..Turn::default()
        })
    };
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend([
            Step::User {
                text: prompt.into(),
            },
            read(),
            read(),
            answer(),
        ]);
    }
    // A notice can start a summarizer beside the worker; draining notices alone
    // does not mean its session.send has reached the runner yet.
    steps.push(Step::Await {
        condition: AwaitCondition::ChildRuns { count: 1 },
        timeout_ms: START_TIMEOUT.as_millis() as u64,
    });
    let report = play(&stack, &PlayRequest { config, steps }).await;
    assert!(report.model_errors.is_empty(), "{:?}", report.model_errors);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    assert!(report.call_errors.is_empty(), "{:?}", report.call_errors);
    assert!(
        !report.child_runs.is_empty(),
        "no summarizer run reached the runner"
    );
    let prefix = format!("{session}:mc-summary:");
    assert!(
        report
            .child_runs
            .iter()
            .all(|child| child.starts_with(&prefix)),
        "{:?}",
        report.child_runs
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "writes to an operator-supplied database copy; run scripts/rehearsal-run.sh in an isolated VM"]
async fn rehearsal_a_head_on_a_real_store() {
    rehearsal::run().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs the daemon and mock runner binaries; run through scripts/wire-gate.sh"]
async fn wire_observations_are_opt_in_and_capture_real_calls() {
    let stack = start_stack();
    let plain = play(
        &stack,
        &PlayRequest {
            config: config("worker"),
            steps: vec![answer()],
        },
    )
    .await;
    assert!(plain.observations.is_none());
    drop(stack);

    let stack = start_stack_with(Path::new(env!("CARGO_BIN_EXE_ck-mc")), None, None, true);
    let mut cfg = config("head");
    cfg.context_window = 100_000;
    cfg.project = Some(mc_mock_runner::runner::Project {
        id: "pj-observe".into(),
        root: stack.project_root.to_string_lossy().into_owned(),
    });
    let mut steps = Vec::new();
    for turn in 0..3 {
        steps.push(Step::User {
            text: format!("Inspect file {turn}."),
        });
        for _ in 0..2 {
            steps.push(Step::Model(Turn {
                tools: vec![ToolCall::ok(
                    "read",
                    json!({"path":"a.rs"}),
                    "x".repeat(48_000),
                )],
                ..Turn::default()
            }));
        }
        steps.push(answer());
    }
    steps.push(Step::Await {
        condition: AwaitCondition::ChildRuns { count: 1 },
        timeout_ms: START_TIMEOUT.as_millis() as u64,
    });
    let report = play(&stack, &PlayRequest { config: cfg, steps }).await;
    let observed = report.observations.unwrap();
    assert_eq!(
        observed.setups[0].answer,
        serde_json::to_value(cortexkit_role_compaction::setup::SetupAnswer::Ready).unwrap()
    );
    assert!(observed.setups[0].elapsed_ms > 0.0);
    assert!(!observed.views.is_empty());
    assert!(observed.views[0]
        .inserted_text
        .join("\n")
        .contains("<session-history>"));
    assert!(observed.views[0].adopted_ms.is_some());
    assert_eq!(observed.tools.len(), 6);
    assert!(observed
        .tools
        .iter()
        .all(|tool| tool.name == "read" && tool.output.len() == 48_000));
    assert_eq!(observed.children.len(), report.child_runs.len());
    assert!(!observed.children.is_empty());
    assert!(observed
        .children
        .iter()
        .all(|child| child.elapsed_ms >= 0.0 && child.started_ms > 0.0));
}

/// The hook and reminder paths over the real wire: a person's message after
/// a six-minute gap gets its time marker through `transform.hook` on the
/// hook route, and once spent results pile up a `ctx_reduce` reminder goes
/// out as a plan-template `session.send` on ck-mc's route to the runner and
/// rides the next tool result.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs the daemon and mock runner binaries; run through scripts/wire-gate.sh"]
async fn a_time_marker_and_a_reduce_reminder_reach_the_runner_over_the_real_wire() {
    let stack = start_stack();
    let mut config = config("worker");
    // A large window: results pile up without reaching the execute
    // threshold, so only the reminder acts.
    config.context_window = 400_000;
    let mut steps = vec![Step::User {
        text: "Survey the repository.".into(),
    }];
    steps.extend((0..10).map(|_| read_file()));
    steps.extend([
        answer(),
        Step::Wait { ms: 6 * 60_000 },
        Step::User {
            text: "Keep going.".into(),
        },
        answer(),
    ]);
    let report = play(&stack, &PlayRequest { config, steps }).await;
    assert!(report.model_errors.is_empty(), "{:?}", report.model_errors);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    assert!(report.call_errors.is_empty(), "{:?}", report.call_errors);
    assert_eq!(report.user_texts.len(), 2, "{:?}", report.user_texts);
    assert_eq!(report.user_texts[0], "Survey the repository.");
    // The hook carries the mock's simulated time. Notice fences keep its
    // session worker caught up before the hook's best-effort reply budget starts.
    assert!(
        report.user_texts[1].starts_with("<!-- +")
            && report.user_texts[1].ends_with("-->\nKeep going."),
        "{:?}",
        report.user_texts
    );
    assert!(
        report
            .delivered_templates
            .iter()
            .any(|template| template.starts_with("mc.ctx_reduce.")),
        "{:?}",
        report.delivered_templates
    );
}

/// Ask the mock runner to fetch a `tool-provider/v1` op from ck-mc.
async fn fetch(stack: &Stack, request: &FetchRequest) -> FetchAnswer {
    let consumer = SubcConsumer::connect(&stack.connection_file, ConsumerOptions::default())
        .await
        .unwrap();
    let reply = consumer
        .call(
            RouteTarget::ManagementSurface {
                module_id: RUNNER.into(),
            },
            BindIdentity::new("mock", "wire-test"),
            wire::encode(MOCK_FETCH, request),
            CallOptions {
                timeout: Duration::from_secs(60),
                ..CallOptions::default()
            },
        )
        .await
        .expect("mock.fetch");
    serde_json::from_slice(&reply).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs the daemon and mock runner binaries; run through scripts/wire-gate.sh"]
async fn a_plan_builder_fetches_the_catalog_with_or_without_declaring_the_role() {
    let stack = start_stack();
    // Wait until both modules are up.
    let _ = play(
        &stack,
        &PlayRequest {
            config: config("worker"),
            steps: vec![answer()],
        },
    )
    .await;
    let arguments = json!({
        "preset": "head",
        "params": {},
        "composition": {"compaction": {"provider": PROVIDER}, "providers": [{
            "provider": PROVIDER,
            "tools": [{"name": "ctx_expand"}, {"name": "ctx_memory"}, {"name": "ctx_note"},
                      {"name": "ctx_reduce"}, {"name": "ctx_search"}],
        }]},
        "system_text": {"preset": "head", "params": {}},
    });
    // The bytes ck-mc serves with no configuration file, which is what the
    // stack's ck-mc runs with.
    let expected = {
        let config = mc_module::config::Config::from(mc_module::pass::Settings::default())
            .catalog_config(None);
        String::from_utf8(mc_module::catalog::catalog_answer_bytes(&arguments, &config).unwrap())
            .unwrap()
    };
    for declare_role in [true, false] {
        let answer = fetch(
            &stack,
            &FetchRequest {
                name: "tool.catalog".into(),
                arguments: arguments.clone(),
                declare_role,
            },
        )
        .await;
        assert_eq!(
            answer,
            FetchAnswer::Reply(expected.clone()),
            "declare_role={declare_role}"
        );
    }
    let FetchAnswer::Reply(describe) = fetch(
        &stack,
        &FetchRequest {
            name: "role.describe".into(),
            arguments: json!({}),
            declare_role: false,
        },
    )
    .await
    else {
        panic!("role.describe was refused");
    };
    let describe: Value = serde_json::from_str(&describe).unwrap();
    cortexkit_role_tool_provider::describe::check_describe(&describe).unwrap();
    // A route that declared no role reaches nothing but those two ops.
    let refused = fetch(
        &stack,
        &FetchRequest {
            name: "ctx_search".into(),
            arguments: json!({"query": "x"}),
            declare_role: false,
        },
    )
    .await;
    assert!(
        matches!(&refused, FetchAnswer::Refused(error) if error.contains("unknown_route_role")),
        "{refused:?}"
    );
}
