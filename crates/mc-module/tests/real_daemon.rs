//! End-to-end checks through a live subc daemon: a real ck-subc spawns mc-module as a
//! provider and a SubcConsumer calls it over the wire. The store is provisioned through
//! the public CLI first, and the module answers its first session request once that
//! store has opened. The daemon build helpers are checked here too.

#![forbid(unsafe_code)]

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    sync::OnceLock,
    time::Duration,
};

use serde_json::{json, Value};
use subc_client_rs::{CallOptions, ConsumerOptions, RetryBackoff, SubcConsumer};
use subc_protocol::{BindIdentity, RouteTarget};

#[path = "support/daemon_checkout.rs"]
mod daemon_checkout;
#[path = "support/executable.rs"]
mod executable_staging;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

const MODULE_ID: &str = "magic-context";
// Cold daemon startup takes ~7s on an idle machine (measured); under CI or
// sibling-build load it can exceed 10s, which failed this suite spuriously.
const START_TIMEOUT: Duration = Duration::from_secs(60);

// ---- process lifecycle ----

struct LiveDaemon {
    child: Child,
    runtime_dir: PathBuf,
    config_dir: PathBuf,
    connection_file: PathBuf,
}

impl Drop for LiveDaemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.runtime_dir);
        let _ = fs::remove_dir_all(&self.config_dir);
    }
}

/// Owns the test's temp root. The daemon and every module process share the data home
/// under it, so cleanup cannot belong to any one of them: bind this first so it drops
/// last, after all of those processes have exited. A failing test keeps the root, since
/// the seeded store and the daemon's log are what a failed run needs for diagnosis.
struct TempRoot(PathBuf);

impl Drop for TempRoot {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

struct ModuleProcess {
    child: Child,
}

impl ModuleProcess {
    fn kill_and_wait(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for ModuleProcess {
    fn drop(&mut self) {
        self.kill_and_wait();
    }
}

// ---- helpers (adapted from subc-client-rs/tests/real_daemon.rs) ----

fn spawn_daemon(
    daemon_bin: &Path,
    runtime_dir: &Path,
    config_dir: &Path,
    data_home: &Path,
) -> LiveDaemon {
    let mut command = Command::new(daemon_bin);
    command
        .env("XDG_RUNTIME_DIR", runtime_dir)
        .env("XDG_CONFIG_HOME", config_dir)
        // The daemon derives `cortexkit/run` (including `logs/`) from the data home, not
        // the runtime dir. Without this, a test daemon's log sink resolves to the host's
        // real `~/.local/share/cortexkit/run/logs/subc.log` and interleaves test boots
        // with production ones. Sharing the module's data home mirrors production layout.
        .env("XDG_DATA_HOME", data_home)
        .env_remove("MAGIC_CONTEXT_TEST_DATA_DIR")
        .env_remove("MAGIC_CONTEXT_STORAGE_DIR")
        .env("HOME", config_dir)
        .env_remove(subc_protocol::SUBC_MODULE_ID_ENV)
        .env_remove(subc_protocol::SUBC_LAUNCH_NONCE_ENV)
        .env_remove(subc_os::LAUNCH_NONCE_FD_ENV)
        .env("SUBC_PORT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let child = executable_staging::retry_spawn(|| command.spawn())
        .unwrap_or_else(|e| panic!("failed to spawn daemon {}: {e}", daemon_bin.display()));
    assert_dev_process_name(child.id());
    LiveDaemon {
        child,
        runtime_dir: runtime_dir.to_path_buf(),
        config_dir: config_dir.to_path_buf(),
        connection_file: runtime_dir.join("subc-connection.json"),
    }
}

fn spawn_module_with_differential(
    module_bin: &Path,
    connection_file: &Path,
    data_home: &Path,
    differential: bool,
) -> ModuleProcess {
    let mut command = Command::new(module_bin);
    command
        .arg("--subc")
        .arg(connection_file)
        .env(subc_protocol::SUBC_MODULE_ID_ENV, MODULE_ID)
        .env_remove(subc_protocol::SUBC_LAUNCH_NONCE_ENV)
        .env_remove(subc_os::LAUNCH_NONCE_FD_ENV)
        .env("XDG_DATA_HOME", data_home)
        .env_remove("MAGIC_CONTEXT_TEST_DATA_DIR")
        .env_remove("MAGIC_CONTEXT_STORAGE_DIR")
        .env(
            "XDG_CONFIG_HOME",
            data_home.parent().unwrap().join("config"),
        )
        .env("HOME", data_home.parent().unwrap().join("config"))
        .env(
            "MC_NATIVE_ATTACHMENT_DIFFERENTIAL",
            if differential { "1" } else { "0" },
        )
        .env(
            "MC_PREFIX_PROJECTION_DIFFERENTIAL",
            if differential { "1" } else { "0" },
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = executable_staging::retry_spawn(|| command.spawn())
        .unwrap_or_else(|e| panic!("failed to spawn module {}: {e}", module_bin.display()));
    assert_dev_process_name(child.id());
    // The module logs to stderr; an undrained pipe fills its 64KB buffer and the module
    // BLOCKS on a stderr write mid-boot, so it never registers (observed as a spurious
    // unknown_module reject once boot logging grew past the buffer). Drain continuously
    // and forward so failures keep the module's log visible.
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::BufRead as _;
            for line in std::io::BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                eprintln!("mc-module: {line}");
            }
        });
    }
    ModuleProcess { child }
}

#[cfg(unix)]
fn assert_dev_process_name(pid: u32) {
    let output = Command::new("ps")
        .args(["-axo", "pid,comm"])
        .output()
        .expect("ps must be available to verify the test process name");
    assert!(output.status.success(), "ps -axo pid,comm failed");
    let process_line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|line| line.split_whitespace().next() == Some(pid.to_string().as_str()))
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

fn write_empty_config(config_dir: &Path) {
    fs::create_dir_all(config_dir.join("cortexkit")).unwrap();
    fs::write(
        config_dir.join("cortexkit").join("subc.jsonc"),
        serde_json::to_string_pretty(&json!({ "version": 1, "modules": {} })).unwrap(),
    )
    .unwrap();
}

fn fast_consumer_options() -> ConsumerOptions {
    ConsumerOptions {
        handshake_timeout: Duration::from_secs(2),
        // Debug-build module cold start under parallel cargo load can push the FIRST
        // transform (bootstrap HARD) past 10s; this suite gates correctness, not latency.
        call_timeout: Duration::from_secs(60),
        reconnect_backoff: RetryBackoff {
            base: Duration::from_millis(50),
            cap: Duration::from_millis(250),
            max_attempts: 40,
        },
        restored_debounce: Duration::from_millis(10),
        // Library default: this harness exercises route/store behavior, not
        // half-open socket detection.
        liveness_probe_window: ConsumerOptions::default().liveness_probe_window,
    }
}

fn fast_call_options() -> CallOptions {
    CallOptions {
        // See fast_consumer_options: first-call cold start under load needs headroom.
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

async fn wait_for_connection_file(path: &Path, wait: Duration) {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        if path.exists() {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("daemon did not write {} within {wait:?}", path.display());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn ensure_module_binary() -> PathBuf {
    static MODULE: OnceLock<PathBuf> = OnceLock::new();
    MODULE
        .get_or_init(|| dev_named_binary(Path::new(env!("CARGO_BIN_EXE_ck-mc"))))
        .clone()
}

struct DaemonBinaries {
    daemon: PathBuf,
    cli: PathBuf,
}

static DAEMON_BUILD_COUNT: AtomicU64 = AtomicU64::new(0);

fn ensure_daemon_build(workspace: &Path) -> &'static DaemonBinaries {
    static BINARIES: OnceLock<DaemonBinaries> = OnceLock::new();
    BINARIES.get_or_init(|| build_daemon_binaries(workspace))
}

fn build_daemon_binaries(workspace: &Path) -> DaemonBinaries {
    let source = locked_daemon_source(workspace);
    // One target for every scenario, durable across test processes. Runtime/config/data
    // directories remain private to each test; sharing immutable executables is safe.
    let target = workspace.join("target/real-daemon-subc");
    let cargo_args = [
        "build",
        "--locked",
        "-p",
        "subc-core",
        "--bins",
        "--target-dir",
        target.to_str().unwrap(),
    ];
    DAEMON_BUILD_COUNT.fetch_add(1, Ordering::Relaxed);
    let output = Command::new("cargo")
        .env("CARGO_BUILD_JOBS", "2")
        .args(cargo_args)
        .current_dir(&source)
        .output()
        .unwrap_or_else(|e| panic!("failed to run cargo {cargo_args:?}: {e}"));
    // Show even successful nested builds so repeated test runs expose recompilation.
    eprintln!(
        "real-daemon nested cargo {cargo_args:?} in {}\n{}",
        source.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.status.success(),
        "cargo {cargo_args:?} failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    DaemonBinaries {
        daemon: dev_named_binary(&daemon_binary_path(&source, &cargo_args)),
        cli: dev_named_binary(&target.join("debug/ck")),
    }
}

fn ensure_daemon_binary(workspace: &Path) -> PathBuf {
    static DAEMON: OnceLock<PathBuf> = OnceLock::new();
    DAEMON
        .get_or_init(|| {
            if let Some(binary) = std::env::var_os("MC_TEST_CK_SUBC_BIN") {
                let path = PathBuf::from(binary);
                assert!(
                    path.is_file(),
                    "test daemon binary is missing: {}",
                    path.display()
                );
                dev_named_binary_as(&path, "subc-prebuilt")
            } else {
                ensure_daemon_build(workspace).daemon.clone()
            }
        })
        .clone()
}

fn locked_subc_revision(lock: &str) -> String {
    let sources: Vec<_> = lock
        .split("[[package]]")
        .filter(|section| section.lines().any(|line| line == "name = \"subc-core\""))
        .flat_map(|section| {
            section
                .lines()
                .filter_map(|line| line.strip_prefix("source = \""))
        })
        .collect();
    assert_eq!(
        sources.len(),
        1,
        "expected one lock-pinned subc-core source"
    );
    let source = sources[0]
        .strip_prefix("git+https://github.com/cortexkit/subconscious?rev=")
        .and_then(|source| source.strip_suffix('"'))
        .expect("subc-core must be pinned to the subconscious Git source");
    let (revision, fragment) = source
        .split_once('#')
        .expect("Git source needs a revision fragment");
    assert_eq!(
        revision, fragment,
        "subc-core revision must match its source fragment"
    );
    assert!(revision.len() == 40 && revision.bytes().all(|b| b.is_ascii_hexdigit()));
    revision.to_owned()
}

fn locked_daemon_source(workspace: &Path) -> PathBuf {
    let revision = locked_subc_revision(&fs::read_to_string(workspace.join("Cargo.lock")).unwrap());
    // An exported source tree keeps isolated tests from inspecting a sibling checkout.
    // Its export marker must agree with the revision selected by this workspace's lockfile.
    if let Some(source) = std::env::var_os("MC_TEST_LOCKED_SUBC_SOURCE") {
        let source = PathBuf::from(source);
        let recorded = fs::read_to_string(source.join(".source-revision")).unwrap();
        assert_eq!(
            recorded.trim(),
            revision,
            "daemon export must match Cargo.lock"
        );
        return source;
    }
    let subconscious = subconscious_root(workspace);
    let compatible = Command::new("git")
        .current_dir(&subconscious)
        .args(["merge-base", "--is-ancestor", "2b0914f0", &revision])
        .status()
        .unwrap();
    assert!(compatible.success(), "Cargo.lock's subconscious revision {revision} must include 2b0914f0 (per-module launch_nonce_env); refusing to pull or modify the sibling checkout");

    // Export the committed tree, not the sibling's possibly newer or dirty worktree.
    // Reuse it on subsequent runs to avoid changing Cargo's source mtimes.
    let parent = workspace.join("target/real-daemon-subc-source");
    let source = parent.join(&revision);
    if source.join("Cargo.toml").is_file() && source.join("Cargo.lock").is_file() {
        return source;
    }
    fs::create_dir_all(&parent).unwrap();
    let scratch = parent.join(format!("{revision}-{}", std::process::id()));
    fs::create_dir_all(&scratch).unwrap();
    let archive = scratch.join("source.tar");
    let exported = Command::new("git")
        .current_dir(&subconscious)
        .args(["archive", "--format=tar", "--output"])
        .arg(&archive)
        .arg(&revision)
        .status()
        .unwrap();
    assert!(
        exported.success(),
        "failed to export locked subconscious revision {revision}"
    );
    let extracted = Command::new("tar")
        .arg("-xf")
        .arg(&archive)
        .arg("-C")
        .arg(&scratch)
        .status()
        .unwrap();
    assert!(
        extracted.success(),
        "failed to extract locked subconscious source"
    );
    fs::remove_file(archive).unwrap();
    fs::rename(&scratch, &source).unwrap();
    source
}

// A caller can isolate its daemon build with --target-dir. Resolve the output
// from that same argument instead of looking in the sibling's default target.
fn daemon_binary_path(subconscious: &Path, cargo_args: &[&str]) -> PathBuf {
    let target = cargo_args
        .iter()
        .enumerate()
        .find_map(|(index, arg)| {
            if *arg == "--target-dir" {
                Some(
                    *cargo_args
                        .get(index + 1)
                        .expect("--target-dir needs a path"),
                )
            } else {
                arg.strip_prefix("--target-dir=")
            }
        })
        .map(|target| subconscious.join(target))
        .unwrap_or_else(|| subconscious.join("target"));
    target.join("debug/ck-subc")
}

#[cfg(unix)]
#[test]
fn daemon_artifacts_are_built_and_copied_once() {
    use std::os::unix::fs::MetadataExt;

    let workspace = workspace_root();
    if !daemon_checkout::available(&workspace) {
        return;
    }
    let first = ensure_daemon_build(&workspace);
    let daemon_inode = fs::metadata(&first.daemon).unwrap().ino();
    let cli_inode = fs::metadata(&first.cli).unwrap().ino();
    let second = ensure_daemon_build(&workspace);
    assert_eq!(first.daemon, second.daemon);
    assert_eq!(first.cli, second.cli);
    assert_eq!(
        DAEMON_BUILD_COUNT.load(Ordering::Relaxed),
        1,
        "daemon build must be memoized, not merely serialized"
    );
    assert_eq!(fs::metadata(&second.daemon).unwrap().ino(), daemon_inode);
    assert_eq!(fs::metadata(&second.cli).unwrap().ino(), cli_inode);
    let target = workspace.join("target/real-daemon-subc/debug");
    assert_ne!(
        daemon_inode,
        fs::metadata(target.join("ck-subc")).unwrap().ino(),
        "daemon must be copied, never hard-linked"
    );
    assert_ne!(
        cli_inode,
        fs::metadata(target.join("ck")).unwrap().ino(),
        "CLI must be copied, never hard-linked"
    );

    let module = ensure_module_binary();
    let module_inode = fs::metadata(&module).unwrap().ino();
    assert_eq!(ensure_module_binary(), module);
    assert_eq!(fs::metadata(&module).unwrap().ino(), module_inode);
    assert_ne!(
        module_inode,
        fs::metadata(env!("CARGO_BIN_EXE_ck-mc")).unwrap().ino(),
        "module must be copied, never hard-linked"
    );
}

#[test]
fn daemon_binary_path_matches_cargo_target_directory() {
    let source = std::env::temp_dir().join("daemon-source");
    let isolated_target = std::env::temp_dir().join("store-init-subc");
    assert_eq!(
        daemon_binary_path(&source, &["build", "--locked", "--bin", "ck-subc"]),
        source.join("target/debug/ck-subc")
    );
    assert_eq!(
        daemon_binary_path(
            &source,
            &["build", "--target-dir", isolated_target.to_str().unwrap()]
        ),
        isolated_target.join("debug/ck-subc")
    );
    assert_eq!(
        daemon_binary_path(&source, &["build", "--target-dir=isolated"]),
        source.join("isolated/debug/ck-subc")
    );
}

/// Run copied Cargo outputs under names that cannot be confused with fleet daemons.
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
    dev_named_binary_as(path, suffix)
}

fn dev_named_binary_as(path: &Path, suffix: &str) -> PathBuf {
    assert!(path.is_file(), "expected binary at {}", path.display());
    let filename = path.file_name().and_then(|name| name.to_str()).unwrap();
    let identifier = filename
        .strip_prefix("ckdev-")
        .map(|name| format!("ck-{}", name.split('-').next().unwrap_or(name)))
        .unwrap_or_else(|| filename.to_string());
    executable_staging::stage_executable(path, &format!("ckdev-{suffix}"), &identifier)
        .unwrap_or_else(|error| {
            panic!(
                "failed to stage test binary {} as ckdev-{suffix}: {error}",
                path.display()
            )
        })
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .to_path_buf()
}

fn subconscious_root(workspace: &Path) -> PathBuf {
    fs::canonicalize(workspace.parent().unwrap().join("subconscious")).unwrap()
}

/// Provision through the public CLI before starting ck-mc, without an OpenCode or Pi
/// session creating context.db first.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hostless_store_init_first_request_through_real_daemon() {
    let workspace = workspace_root();
    if !daemon_checkout::available(&workspace) {
        return;
    }
    let daemon_bin = ensure_daemon_binary(&workspace);
    let module_bin = ensure_module_binary();
    let parent = std::env::temp_dir().join("magic-context/store-init");
    fs::create_dir_all(&parent).unwrap();
    let temp = TempRoot(parent.join(format!(
        "daemon-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    )));
    let runtime = temp.0.join("runtime");
    let config = temp.0.join("config");
    let data = temp.0.join("data");
    let project = temp.0.join("project");
    for dir in [&runtime, &data, &project] {
        fs::create_dir_all(dir).unwrap();
    }
    write_empty_config(&config);
    let context_path = data.join("cortexkit/magic-context/context.db");
    assert!(!context_path.exists());
    provision_context_store(&workspace, &config, &data);
    assert!(
        context_path.exists(),
        "doctor store init must create context.db"
    );
    let daemon = spawn_daemon(&daemon_bin, &runtime, &config, &data);
    wait_for_connection_file(&daemon.connection_file, START_TIMEOUT).await;
    let _module =
        spawn_module_with_differential(&module_bin, &daemon.connection_file, &data, false);
    let consumer = SubcConsumer::connect(&daemon.connection_file, fast_consumer_options())
        .await
        .unwrap();
    let identity = BindIdentity::new(project, "mc-module-test", "hostless");
    let target = RouteTarget::ToolProvider {
        module_id: MODULE_ID.to_string(),
    };
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    loop {
        let probe = consumer
            .call(
                target.clone(),
                identity.clone(),
                serde_json::to_vec(&json!({"kind":"status", "v":1})).unwrap(),
                fast_call_options(),
            )
            .await;
        if !matches!(&probe, Err(e) if format!("{e:?}").contains("unknown_module")) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "module did not register"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // The module answers the first session request with a retryable `store_opening`
    // while its store is still opening in the background, as a runner would see.
    // Retry that one code until the deadline, like any runner; anything else fails.
    let request = serde_json::to_vec(&json!({
        "method": "session.status", "v": 1, "session_id": "hostless",
    }))
    .unwrap();
    let bytes = loop {
        match consumer
            .call(
                target.clone(),
                identity.clone(),
                request.clone(),
                fast_call_options(),
            )
            .await
        {
            Err(e) if format!("{e:?}").contains("store_opening") => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "store never finished opening: {e:?}"
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            other => break other.unwrap(),
        }
    };
    let response: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(response["ok"], true, "first request failed: {response}");
    let store = rusqlite::Connection::open_with_flags(
        data.join("cortexkit/magic-context/store.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let version: i64 = store
        .query_row(
            "SELECT version FROM cortexkit_schema_version WHERE namespace = 'mc_cache' AND version = 61",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, 61);
    let stamp: String = store
        .query_row(
            "SELECT single_store_set_by FROM mc_privilege_state WHERE id = 1 AND single_store = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        stamp.ends_with("+fresh"),
        "unexpected fresh marker: {stamp}"
    );
    let context = rusqlite::Connection::open_with_flags(
        context_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let (state, by): (String, String) = context
        .query_row(
            "SELECT state, migrated_by FROM single_store_state WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, "migrated");
    assert_eq!(by, stamp);
}

// Production modules require an existing host-schema store before opening storage.
// Provision it through the CLI in the test's isolated roots, just as setup does.
fn provision_context_store(workspace: &Path, config: &Path, data: &Path) {
    let output = Command::new("bun")
        .args([
            "run",
            "packages/cli/src/index.ts",
            "doctor",
            "store",
            "init",
        ])
        .current_dir(workspace)
        .env("HOME", config)
        .env("XDG_CONFIG_HOME", config)
        .env("XDG_DATA_HOME", data)
        .env_remove("MAGIC_CONTEXT_TEST_DATA_DIR")
        .env_remove("MAGIC_CONTEXT_STORAGE_DIR")
        .output()
        .expect("bun must be installed to provision the host-schema store");
    assert!(
        output.status.success(),
        "store init failed: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
