//! End-to-end check that a ck-mc started on a `store.db` migrated past its own chain refuses
//! loudly through a live subc daemon.
//!
//! A real ck-subc runs, a real ck-mc registers with it, and the store it opens records one
//! migration version more than the binary carries: the shape a binary-only rollback leaves
//! behind. The test asserts what an operator and an adapter each see: `ck health magic-context`
//! names the refusal with both versions, and a transform request gets the typed
//! `store_ahead_of_binary` error frame instead of an answer. It also checks that nothing the
//! module did while refusing changed the store file.
//!
//! Kept in its own test binary because the spine test in `real_daemon.rs` owns a process-wide
//! project base, and because this one must run against a store no other test touches.

#![forbid(unsafe_code)]

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::Duration,
};

use mc_store::{McStore, LATEST_MIGRATION_VERSION, STORE_AHEAD_OF_BINARY_REFUSAL_REASON};
use serde_json::{json, Value};
use subc_client_rs::{CallError, CallOptions, ConsumerOptions, RetryBackoff, SubcConsumer};
use subc_protocol::{BindIdentity, RouteTarget};

const MODULE_ID: &str = "magic-context";
// Cold daemon and debug-module startup under sibling build load; see real_daemon.rs.
const START_TIMEOUT: Duration = Duration::from_secs(60);

/// Every directory a spawned process could read configuration or data from, all under one
/// throwaway root so no process in this test can reach a real user store.
struct Isolation {
    root: PathBuf,
    home: PathBuf,
    data_home: PathBuf,
    config_home: PathBuf,
    state_home: PathBuf,
    runtime_dir: PathBuf,
}

impl Isolation {
    fn new() -> Self {
        let root = std::env::temp_dir()
            .join("magic-context")
            .join(format!("store-ahead-real-daemon-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let isolation = Self {
            home: root.join("home"),
            data_home: root.join("data"),
            config_home: root.join("config"),
            state_home: root.join("state"),
            runtime_dir: root.join("runtime"),
            root,
        };
        for dir in [
            &isolation.home,
            &isolation.data_home,
            &isolation.config_home,
            &isolation.state_home,
            &isolation.runtime_dir,
        ] {
            fs::create_dir_all(dir).unwrap();
        }
        fs::create_dir_all(isolation.config_home.join("cortexkit")).unwrap();
        fs::write(
            isolation.config_home.join("cortexkit").join("subc.jsonc"),
            serde_json::to_string_pretty(&json!({ "version": 1, "modules": {} })).unwrap(),
        )
        .unwrap();
        isolation
    }

    fn apply(&self, command: &mut Command) {
        command
            .env("HOME", &self.home)
            .env("XDG_DATA_HOME", &self.data_home)
            .env("XDG_CONFIG_HOME", &self.config_home)
            .env("XDG_STATE_HOME", &self.state_home)
            .env("XDG_RUNTIME_DIR", &self.runtime_dir)
            .env(
                "OPENCODE_DB",
                self.data_home.join("opencode").join("opencode.db"),
            )
            .env(
                "MAGIC_CONTEXT_STORAGE_DIR",
                self.data_home.join("cortexkit").join("magic-context"),
            )
            .env_remove(subc_protocol::SUBC_LAUNCH_NONCE_ENV)
            .env_remove(subc_os::LAUNCH_NONCE_FD_ENV);
    }

    fn connection_file(&self) -> PathBuf {
        self.runtime_dir.join("subc-connection.json")
    }
}

impl Drop for Isolation {
    fn drop(&mut self) {
        // A failing run keeps the root: the stamped store and the logs are the evidence.
        if !std::thread::panicking() {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

struct Process(Child);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(unix)]
fn assert_dev_process_name(pid: u32) {
    let output = Command::new("ps")
        .args(["-axo", "pid,comm"])
        .output()
        .expect("ps must be available to verify the test process name");
    assert!(output.status.success(), "ps -axo pid,comm failed");
    let pid_text = pid.to_string();
    let process_line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|line| line.split_whitespace().next() == Some(pid_text.as_str()))
        .map(str::to_owned)
        .unwrap_or_else(|| panic!("ps -axo pid,comm did not list test PID {pid}"));
    let executable = process_line
        .split_whitespace()
        .nth(1)
        .and_then(|command| Path::new(command).file_name())
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    assert!(
        executable.starts_with("ckdev-"),
        "test PID {pid} must not look like a production fleet binary: {process_line}"
    );
    println!("ps -axo pid,comm: {process_line}");
}

#[cfg(not(unix))]
fn assert_dev_process_name(_: u32) {}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_module_on_a_store_ahead_of_it_refuses_on_health_and_on_transform() {
    std::env::remove_var(subc_protocol::SUBC_MODULE_ID_ENV);
    std::env::remove_var(subc_protocol::SUBC_LAUNCH_NONCE_ENV);
    std::env::remove_var(subc_os::LAUNCH_NONCE_FD_ENV);

    let workspace = workspace_root();
    let subconscious = workspace.parent().unwrap().join("subconscious");
    let daemon_bin = ensure_binary(
        &subconscious,
        subconscious.join("target/debug/ck-subc"),
        &["build", "-p", "subc-core", "--bins"],
    );
    let ck_bin = dev_named_binary(
        &std::env::var_os("MC_TEST_CK_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| subconscious.join("target/debug/ck")),
    );
    assert!(ck_bin.exists(), "expected ck at {}", ck_bin.display());
    let module_bin = ensure_binary(
        &workspace,
        workspace.join("target/debug/ck-mc"),
        &["build", "-p", "mc-module"],
    );

    // Declared before the processes so it drops after them.
    let isolation = Isolation::new();

    // The store a newer ck-mc left behind: migrated to this binary's newest version and then
    // stamped one past it. Dropping the handle releases the single-writer lease and
    // checkpoints the WAL into the main file before the module starts.
    let descriptor = mc_module::dev_descriptor_at(&isolation.data_home.to_string_lossy());
    let ahead = LATEST_MIGRATION_VERSION + 1;
    let newer = McStore::open_for_test(&descriptor).expect("create the store");
    newer
        .stamp_schema_version_for_test(ahead)
        .expect("stamp the store one version ahead");
    drop(newer);
    let store_path = match &descriptor.backend {
        cortexkit_store_types::StorageBackend::Sqlite { path } => PathBuf::from(path),
        other => panic!("dev descriptor must be sqlite, got {other:?}"),
    };
    let store_before = fs::read(&store_path).unwrap();

    let mut daemon_command = Command::new(&daemon_bin);
    isolation.apply(&mut daemon_command);
    let _daemon = Process(
        daemon_command
            .env("SUBC_PORT", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap_or_else(|e| panic!("failed to spawn daemon {}: {e}", daemon_bin.display())),
    );
    assert_dev_process_name(_daemon.0.id());
    wait_for_path(&isolation.connection_file(), START_TIMEOUT).await;

    let mut module_command = Command::new(&module_bin);
    isolation.apply(&mut module_command);
    let mut module_child = module_command
        .arg("--subc")
        .arg(isolation.connection_file())
        .env(subc_protocol::SUBC_MODULE_ID_ENV, MODULE_ID)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("failed to spawn module {}: {e}", module_bin.display()));
    assert_dev_process_name(module_child.id());
    // Drain stderr so the module never blocks on a full pipe, and forward it so a failing run
    // keeps the module's output.
    if let Some(stderr) = module_child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::BufRead as _;
            for line in std::io::BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                eprintln!("mc-module: {line}");
            }
        });
    }
    let _module = Process(module_child);

    let consumer = SubcConsumer::connect(&isolation.connection_file(), consumer_options())
        .await
        .unwrap();
    wait_for_module_registration(&consumer, START_TIMEOUT).await;

    // `ck health magic-context`, as an operator runs it. The open is refused at startup, so
    // wait for the refusal to be recorded rather than racing the first probe.
    let health = wait_for_refused_health(&ck_bin, &isolation, START_TIMEOUT).await;
    // Printed so a run with --nocapture shows the operator's exact text.
    eprintln!("ck --json health {MODULE_ID}: {health}");
    assert_eq!(health["status"], "failing", "{health}");
    let detail = health["detail"].as_str().unwrap_or_default();
    assert!(
        detail.contains(&format!(
            "{STORE_AHEAD_OF_BINARY_REFUSAL_REASON}: db_version={ahead} binary_max={LATEST_MIGRATION_VERSION}"
        )),
        "ck health must name the refusal and both versions: {health}"
    );
    assert!(
        detail.contains("context.db and store.db from the same backup"),
        "ck health must carry the remediation: {health}"
    );
    assert_eq!(
        health["metrics"]["storage_state"],
        "open_refused_store_ahead"
    );
    assert_eq!(health["metrics"]["store_db_version"], ahead);
    assert_eq!(
        health["metrics"]["binary_max_store_version"],
        LATEST_MIGRATION_VERSION
    );

    // A transform request gets the typed refusal, with both versions as detail.
    let transform = consumer
        .call(
            RouteTarget::ToolProvider {
                module_id: MODULE_ID.to_string(),
            },
            identity(&isolation, "ahead"),
            serde_json::to_vec(&json!({
                "kind": "transform",
                "v": 2,
                "serializer_profile": "owned-llmrunner",
                "session_id": "ahead",
                "render_config": "cfg0",
                "messages": [],
            }))
            .unwrap(),
            call_options(),
        )
        .await;
    let Err(CallError::Module(body)) = transform else {
        panic!(
            "a transform on a refused store must fail with a module error frame, got {transform:?}"
        );
    };
    eprintln!("transform error frame: {body:?}");
    assert_eq!(body.code, STORE_AHEAD_OF_BINARY_REFUSAL_REASON, "{body:?}");
    assert_eq!(
        body.detail,
        Some(json!({
            "reason_code": STORE_AHEAD_OF_BINARY_REFUSAL_REASON,
            "db_version": ahead,
            "binary_max": LATEST_MIGRATION_VERSION,
        })),
        "{body:?}"
    );

    drop(consumer);
    drop(_module);
    assert_eq!(
        fs::read(&store_path).unwrap(),
        store_before,
        "the refusing module must not have written to store.db"
    );
}

/// Poll `ck --json health magic-context` until it reports the refused open. Health is probed
/// live from the module, so the first probe can land before the open has ended.
async fn wait_for_refused_health(ck_bin: &Path, isolation: &Isolation, wait: Duration) -> Value {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let mut command = Command::new(ck_bin);
        isolation.apply(&mut command);
        let output = command
            .arg("--subc")
            .arg(isolation.connection_file())
            .arg("--json")
            .arg("health")
            .arg(MODULE_ID)
            .stdin(Stdio::null())
            .output()
            .unwrap_or_else(|e| panic!("failed to run {}: {e}", ck_bin.display()));
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        if let Ok(value) = serde_json::from_str::<Value>(&stdout) {
            if value["metrics"]["storage_state"] == "open_refused_store_ahead" {
                return value;
            }
            if tokio::time::Instant::now() >= deadline {
                panic!("ck health never reported the refusal; last: {value}");
            }
        } else if tokio::time::Instant::now() >= deadline {
            panic!(
                "ck health never answered with JSON; status {:?} stdout {stdout} stderr {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            );
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn identity(isolation: &Isolation, session: &str) -> BindIdentity {
    let project = isolation.root.join("projects").join(session);
    fs::create_dir_all(&project).unwrap();
    BindIdentity::new(
        fs::canonicalize(&project).unwrap_or(project),
        "mc-module-test",
        session,
    )
}

async fn wait_for_module_registration(consumer: &SubcConsumer, wait: Duration) {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let probe = consumer
            .call(
                RouteTarget::ToolProvider {
                    module_id: MODULE_ID.to_string(),
                },
                BindIdentity::new(std::env::temp_dir(), "mc-module-test", "registration-probe"),
                serde_json::to_vec(&json!({ "kind": "echo", "v": 1 })).unwrap(),
                call_options(),
            )
            .await;
        match probe {
            Ok(_) => return,
            Err(err) if !format!("{err:?}").contains("unknown_module") => return,
            Err(_) => {}
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("module did not register with the daemon within {wait:?}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_path(path: &Path, wait: Duration) {
    let deadline = tokio::time::Instant::now() + wait;
    while !path.exists() {
        if tokio::time::Instant::now() >= deadline {
            panic!("daemon did not write {} within {wait:?}", path.display());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn consumer_options() -> ConsumerOptions {
    ConsumerOptions {
        handshake_timeout: Duration::from_secs(2),
        call_timeout: Duration::from_secs(60),
        reconnect_backoff: RetryBackoff {
            base: Duration::from_millis(50),
            cap: Duration::from_millis(250),
            max_attempts: 40,
        },
        restored_debounce: Duration::from_millis(10),
        liveness_probe_window: ConsumerOptions::default().liveness_probe_window,
    }
}

fn call_options() -> CallOptions {
    CallOptions {
        timeout: Duration::from_secs(60),
        route_retry: RetryBackoff {
            base: Duration::from_millis(50),
            cap: Duration::from_millis(250),
            max_attempts: 60,
        },
        route_retry_deadline: Duration::from_secs(60),
        ..CallOptions::default()
    }
}

fn ensure_binary(manifest_dir: &Path, path: PathBuf, cargo_args: &[&str]) -> PathBuf {
    if path.file_name().is_some_and(|name| name == "ck-subc") {
        if let Some(binary) = std::env::var_os("MC_TEST_CK_SUBC_BIN") {
            let binary = PathBuf::from(binary);
            assert!(
                binary.is_file(),
                "test daemon binary is missing: {}",
                binary.display()
            );
            return dev_named_binary(&binary);
        }
    }
    static BUILD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = BUILD_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let output = Command::new("cargo")
        .args(cargo_args)
        .current_dir(manifest_dir)
        .output()
        .unwrap_or_else(|e| panic!("failed to run cargo {cargo_args:?}: {e}"));
    assert!(
        output.status.success(),
        "cargo {cargo_args:?} failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(path.exists(), "expected binary at {}", path.display());
    dev_named_binary(&path)
}

/// Keep test daemon and module process names distinct from installed fleet binaries.
fn dev_named_binary(path: &Path) -> PathBuf {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .expect("test binary must have a UTF-8 filename");
    let suffix = if filename == "ck" {
        "cli"
    } else {
        filename
            .strip_prefix("ckdev-")
            .or_else(|| filename.strip_prefix("ck-"))
            .unwrap_or_else(|| panic!("expected a ck, ck-* or ckdev-* test binary, got {filename}"))
    };
    let dev_dir = std::env::temp_dir()
        .join("magic-context/mc-module-test-binaries")
        .join(std::process::id().to_string());
    fs::create_dir_all(&dev_dir).expect("create isolated binary staging directory");
    let dev_path = dev_dir.join(format!("ckdev-{suffix}"));
    if path == dev_path.as_path() {
        return dev_path;
    }
    let _ = fs::remove_file(&dev_path);
    // A copy, never a hard link: on macOS a daemon exec'd through a hard link to
    // cargo's output was occasionally SIGKILLed at startup, while a copy never was.
    fs::copy(path, &dev_path)
        .map(|_| ())
        .unwrap_or_else(|error| {
            panic!(
                "failed to stage test binary {} as {}: {error}",
                path.display(),
                dev_path.display()
            )
        });
    dev_path
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .to_path_buf()
}
