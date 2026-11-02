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

use ck_contract_draft::read::SessionRef;
use ck_contract_draft::rules::{EditCost, ProviderRules, SignedParts};
use ck_contract_draft::setup::ModelRef;
use ck_contract_draft::wire;
use mc_mock_runner::model::Kind;
use mc_mock_runner::runner::{Report, SessionConfig};
use mc_mock_runner::script::{Step, ToolCall, Turn};
use mc_mock_runner::subc::{PlayRequest, MOCK_PLAY};
use serde_json::{json, Value};
use subc_client_rs::{CallOptions, ConsumerOptions, SubcConsumer};
use subc_protocol::{BindIdentity, RouteTarget, SUBC_LAUNCH_NONCE_ENV, SUBC_MODULE_ID_ENV};

const PROVIDER: &str = "magic-context";
const RUNNER: &str = "mock-runner";
/// Read by a launched child to find its launch nonce; a test-launched module
/// must not inherit one.
const LAUNCH_NONCE_FD_ENV: &str = "SUBC_LAUNCH_NONCE_FD";
const START_TIMEOUT: Duration = Duration::from_secs(60);

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
    env: &[(&str, &str)],
    label: &'static str,
) -> Process {
    let mut command = Command::new(program);
    command
        .args(args)
        .env("XDG_RUNTIME_DIR", root.join("runtime"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_DATA_HOME", root.join("data"))
        .env("HOME", root.join("config"))
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
    _processes: Vec<Process>,
    _root: Root,
}

fn start_stack() -> Stack {
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
    let module = dev_copy(Path::new(env!("CARGO_BIN_EXE_ck-mc")), &root, "mc");
    let connection_file = root.join("runtime/subc-connection.json");
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
                RUNNER: entry(&runner, json!({"MOCK_RUNNER_PROVIDER": PROVIDER})),
            },
        })
        .to_string(),
    )
    .unwrap();

    let processes = vec![spawn(
        &daemon,
        &[],
        &root,
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
        _processes: processes,
        _root: Root(root),
    }
}

/// Ask the mock runner to play a scenario, waiting for both modules to
/// register first.
async fn play(stack: &Stack, request: &PlayRequest) -> Report {
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
                wire::encode(MOCK_PLAY, request),
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

const FREE: ProviderRules = ProviderRules {
    signed_parts: SignedParts::None,
    history_edit_cost: EditCost::Suffix,
};

fn config(preset: &str) -> SessionConfig {
    SessionConfig {
        session: SessionRef {
            runner: RUNNER.into(),
            harness: "mock".into(),
            session: format!("wire-{}", COUNTER.fetch_add(1, Ordering::Relaxed)),
        },
        preset: preset.into(),
        model: ModelRef {
            provider: "test".into(),
            model: "test-model".into(),
            variant: None,
            service_tier: None,
        },
        context_window: 40_000,
        output_reserve: 1_000,
        rules: FREE,
        kind: Kind::OpenAi,
        cache_ttl_ms: 300_000,
        system_tokens: 500,
        tag_checkpoint: 0,
        moved_in: None,
        start_ms: 1_000_000,
        project: None,
        model_latency_ms: 200,
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
            wire::encode(ck_contract_draft::ops::COMPACTION_SETUP, &setup),
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
