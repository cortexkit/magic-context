//! Compare standalone identities and memory-prefix bytes against release v0.49.2.

#![cfg(unix)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use subc_control::{ClientControlRequest, ClientControlResponse};
use subc_protocol::{Flags, Frame, FrameType, Priority};
use subc_transport::{
    authenticate_server, generate_daemon_id, generate_key, read_frame, write_atomic, write_frame,
    ConnectionInfo, Endpoint, SCHEMA_VERSION,
};

fn checked(command: &mut Command) -> Vec<u8> {
    let output = command.output().expect("spawn fixture command");
    assert!(
        output.status.success(),
        "{command:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn git(directory: &Path, args: &[&str]) -> String {
    String::from_utf8(checked(
        Command::new("git")
            .args(args)
            .current_dir(directory)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
            .env("GIT_AUTHOR_DATE", "2025-01-01T00:00:00Z")
            .env("GIT_COMMITTER_DATE", "2025-01-01T00:00:00Z"),
    ))
    .unwrap()
    .trim()
    .to_string()
}

fn fixture(directory: &Path, scenario: &str) -> Option<String> {
    if directory.exists() {
        std::fs::remove_dir_all(directory).unwrap();
    }
    std::fs::create_dir_all(directory).unwrap();
    if scenario == "plain" {
        return None;
    }
    git(directory, &["init", "-b", "main"]);
    git(
        directory,
        &[
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ],
    );
    let commit = git(directory, &["rev-parse", "HEAD"]);
    if scenario == "unborn" {
        git(directory, &["update-ref", "refs/fixture/first", &commit]);
        git(directory, &["update-ref", "-d", "refs/heads/main"]);
    }
    Some(commit)
}

// Compile the source files themselves, not a reimplementation of their algorithms. The
// harness expires a failed git probe's cached result before retrying, avoiding its normal
// five-minute cooldown without changing how either resolver computes the identity.
fn compile_host(
    repo: &Path,
    scratch: &Path,
    revision: Option<&str>,
    libraries: &HashMap<String, PathBuf>,
) -> PathBuf {
    std::fs::create_dir_all(scratch).unwrap();
    for name in [
        "project_identity",
        "memory_render",
        "decay_render",
        "entorhinal_resolve",
        "route_targets",
        "project_pin_writer",
    ] {
        if matches!(
            name,
            "entorhinal_resolve" | "route_targets" | "project_pin_writer"
        ) && revision.is_some()
        {
            continue;
        }
        let path = format!("crates/mc-module/src/{name}.rs");
        let mut source = match revision {
            Some(revision) => checked(
                Command::new("git")
                    .args(["show", &format!("{revision}:{path}")])
                    .current_dir(repo),
            ),
            None => std::fs::read(repo.join(path)).unwrap(),
        };
        if name == "project_identity" {
            source.extend_from_slice(b"\npub fn expire(resolver: &ProjectIdentityResolver, path: &std::path::Path) { if let Some(cached) = resolver.cache.lock().unwrap().get_mut(path) { cached.revalidate_at = Some(std::time::Instant::now()); } }\n");
        }
        std::fs::write(scratch.join(format!("{name}.rs")), source).unwrap();
    }
    let start = if revision.is_some() {
        "resolver.resolve(&directory)"
    } else {
        "entorhinal_resolve::EntorhinalResolver::new(Some(connection.clone())).resolve_for_session(&resolver, &directory, \"standalone-test\", scenario, None).await"
    };
    let source = format!(
        r#"
#![allow(dead_code)]
pub use mc_module::{{agent_data, host_store, decision_calibration, historian_runner}};
mod config {{
    pub use mc_module::config::{{private_storage_permissions_enabled, ConfiguredRunners}};
    pub fn user_home_dir() -> Option<std::path::PathBuf> {{ std::env::var_os("HOME").map(Into::into) }}
}}
mod transform {{
    pub fn string_from_js_utf16_prefix(_: &[u16], _: usize) -> String {{
        panic!("empty history fixture must not truncate text")
    }}
}}
mod project_identity;
mod memory_render;
mod decay_render;
{entorhinal}
use std::io::{{BufRead, Write}};
use std::path::PathBuf;
use serde_json::{{json, Value}};
#[tokio::main(flavor = "current_thread")]
async fn main() {{
    let args: Vec<String> = std::env::args().collect();
    let connection = PathBuf::from(&args[1]);
    let _db = rusqlite::Connection::open(&args[2]).unwrap();
    let resolver = project_identity::ProjectIdentityResolver::new();
    println!("READY");
    std::io::stdout().flush().unwrap();
    for line in std::io::stdin().lock().lines() {{
        let command: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let directory = PathBuf::from(command["directory"].as_str().unwrap());
        let scenario = command["scenario"].as_str().unwrap();
        if command["expire"] == true {{ project_identity::expire(&resolver, &directory); }}
        let outcome = if command["start"] == true {{ {start} }} else {{ resolver.resolve(&directory) }};
        let (identity, error) = match outcome {{ Ok(identity) => (Some(identity), None), Err(error) => (None, Some(error.code())) }};
        let memories: Vec<mc_store::StoredMemory> = identity.as_ref().map(|key| mc_store::StoredMemory {{
            id: 1, category: "USER_DIRECTIVES".into(), content: format!("standalone memory for {{key}}"),
            status: "active".into(), ..Default::default()
        }}).into_iter().collect();
        let prefix = memory_render::render_m0(&memory_render::M0Inputs {{
            project_docs: "", user_profile: &[], covered_system_messages: &[], compartments: &[],
            memories: &memories, source_name_by_id: &Default::default(), {workspace_memory_block}history_budget_tokens: 1000.0,
            decay_pressure_multiplier: 1.0,
        }}, |text| text.len() / 4);
        println!("{{}}", json!({{"identity": identity, "error": error, "prefix": prefix}}));
        std::io::stdout().flush().unwrap();
    }}
}}
"#,
        workspace_memory_block = if revision.is_some() {
            ""
        } else {
            "workspace_memory_block: None, "
        },
        entorhinal = if revision.is_some() {
            ""
        } else {
            "mod entorhinal_resolve; mod route_targets;"
        },
    );
    std::fs::write(scratch.join("host.rs"), source).unwrap();
    let deps = libraries["subc_client_rs"].parent().unwrap().to_path_buf();
    let mut command = Command::new("rustc");
    command
        .args(["--edition=2021", "-L"])
        .arg(format!("dependency={}", deps.display()))
        .arg(scratch.join("host.rs"))
        .arg("-o")
        .arg(scratch.join("host"));
    for name in [
        "mc_module",
        "mc_core",
        "mc_store",
        "mc_tokenizer",
        "serde",
        "serde_json",
        "sha2",
        "tokio",
        "subc_client_rs",
        "subc_protocol",
        "tracing",
        "rusqlite",
    ] {
        let library = libraries
            .get(name)
            .unwrap_or_else(|| panic!("missing linked dependency {name}"));
        command
            .arg("--extern")
            .arg(format!("{name}={}", library.display()));
    }
    checked(&mut command);
    scratch.join("host")
}

// The target directory can contain several versions of the same crate. Ask Cargo
// for this package's direct dependency graph and build artifacts rather than
// linking whichever rlib happens to have the newest filesystem timestamp.
fn host_libraries(repo: &Path) -> HashMap<String, PathBuf> {
    let metadata: Value = serde_json::from_slice(&checked(
        Command::new("cargo")
            .args(["metadata", "--locked", "--format-version=1"])
            .current_dir(repo)
            .env("RUSTC_WRAPPER", "")
            .env("CARGO_BUILD_RUSTC_WRAPPER", ""),
    ))
    .unwrap();
    let package_id = metadata["packages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|package| package["name"] == "mc-module")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let node = metadata["resolve"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["id"] == package_id)
        .unwrap();
    let mut names: HashMap<&str, &str> = node["deps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|dep| (dep["pkg"].as_str().unwrap(), dep["name"].as_str().unwrap()))
        .collect();
    names.insert(package_id, "mc_module");
    let artifacts = checked(
        Command::new("cargo")
            .args([
                "build",
                "--locked",
                "-p",
                "mc-module",
                "--lib",
                "--message-format=json",
            ])
            .current_dir(repo)
            .env("RUSTC_WRAPPER", "")
            .env("CARGO_BUILD_RUSTC_WRAPPER", ""),
    );
    let mut libraries = HashMap::new();
    for line in artifacts
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let artifact: Value = serde_json::from_slice(line).unwrap();
        if artifact["reason"] != "compiler-artifact" {
            continue;
        }
        let Some(name) = artifact["package_id"].as_str().and_then(|id| names.get(id)) else {
            continue;
        };
        for file in artifact["filenames"].as_array().unwrap() {
            let path = PathBuf::from(file.as_str().unwrap());
            if path
                .extension()
                .is_some_and(|extension| extension == "rlib")
            {
                libraries.insert((*name).to_owned(), path);
            }
        }
    }
    libraries
}

struct Host {
    child: Child,
    output: BufReader<std::process::ChildStdout>,
}

impl Host {
    fn start(binary: &Path, connection: &Path, isolation: &Path) -> Self {
        std::fs::create_dir_all(isolation).unwrap();
        let mut command = Command::new(binary);
        command
            .arg(connection)
            .arg(isolation.join("host.db"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env("HOME", isolation.join("home"))
            .env("MAGIC_CONTEXT_TEST_DATA_DIR", isolation)
            .env(
                "MAGIC_CONTEXT_STORAGE_DIR",
                isolation.join("cortexkit/magic-context"),
            )
            .env("OPENCODE_DB", isolation.join("opencode.db"));
        for key in [
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "XDG_RUNTIME_DIR",
        ] {
            command.env(key, isolation.join(key));
        }
        command.env("XDG_DATA_HOME", isolation);
        let mut child = command.spawn().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        output.read_line(&mut ready).unwrap();
        assert_eq!(ready.trim(), "READY");
        let descriptors =
            checked(Command::new("lsof").args(["-p", &child.id().to_string(), "-Fn"]));
        let descriptors = String::from_utf8(descriptors).unwrap();
        let databases: Vec<_> = descriptors
            .lines()
            .filter(|line| line.starts_with('n') && line.contains(".db"))
            .collect();
        assert!(
            !databases.is_empty(),
            "host database must be open during lsof"
        );
        for database in &databases {
            assert!(
                Path::new(&database[1..]).starts_with(isolation),
                "{database}"
            );
        }
        println!("lsof -p {}: {databases:?}", child.id());
        Self { child, output }
    }

    fn sample(&mut self, directory: &Path, scenario: &str, start: bool, expire: bool) -> Value {
        writeln!(
            self.child.stdin.as_mut().unwrap(),
            "{}",
            json!({
                "directory": directory, "scenario": scenario, "start": start, "expire": expire
            })
        )
        .unwrap();
        self.child.stdin.as_mut().unwrap().flush().unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap_or_else(|_| panic!("missing host sample: {line}"))
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.child.stdin.take();
        assert!(self.child.wait().unwrap().success());
    }
}

struct AbsentModule {
    connection: PathBuf,
    calls: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for AbsentModule {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn absent_module(directory: &Path) -> AbsentModule {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let key = generate_key().unwrap();
    let daemon_id = generate_daemon_id().unwrap();
    let connection = directory.join("connection.json");
    write_atomic(
        &connection,
        &ConnectionInfo {
            schema: SCHEMA_VERSION,
            wire_version: Some(subc_protocol::PROTOCOL_VERSION),
            endpoints: vec![Endpoint {
                host: address.ip().to_string(),
                port: address.port(),
            }],
            key: key.clone(),
            daemon_id,
            pid: std::process::id(),
            daemon_ver: "fake".into(),
        },
    )
    .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            if authenticate_server(
                &mut stream,
                &key,
                &daemon_id,
                "fake",
                Duration::from_secs(2),
            )
            .await
            .is_err()
            {
                continue;
            }
            while let Ok(Some(frame)) = read_frame(&mut stream).await {
                if frame.header.ty != FrameType::Request {
                    continue;
                }
                let (ty, body) = if frame.header.channel == 0 {
                    let control: ClientControlRequest =
                        serde_json::from_slice(&frame.body).unwrap();
                    let ClientControlRequest::RouteOpen { target, .. } = control else {
                        continue;
                    };
                    assert_eq!(target, mc_module::entorhinal_resolve::route_target());
                    (
                        FrameType::Response,
                        serde_json::to_vec(&ClientControlResponse::RouteOpen {
                            route_channel: 7,
                            route_epoch: 1,
                        })
                        .unwrap(),
                    )
                } else {
                    let request: Value = serde_json::from_slice(&frame.body).unwrap();
                    assert_eq!(request["method"], "resolve");
                    observed.fetch_add(1, Ordering::SeqCst);
                    (FrameType::Error, serde_json::to_vec(&json!({
                        "code": "unknown_module", "message": "Entorhinal is not loaded", "detail": null
                    })).unwrap())
                };
                let response = Frame::build(
                    ty,
                    Flags::new(false, Priority::Interactive, false),
                    frame.header.channel,
                    frame.header.epoch,
                    frame.header.corr,
                    body,
                )
                .unwrap();
                if write_frame(&mut stream, &response).await.is_err() {
                    break;
                }
            }
        }
    });
    AbsentModule {
        connection,
        calls,
        task,
    }
}

fn transcript(
    binary: &Path,
    fixture_root: &Path,
    connection: &Path,
    isolation: &Path,
) -> Vec<Value> {
    let mut host = Host::start(binary, connection, isolation);
    let mut transcript = Vec::new();
    for scenario in ["stable", "plain", "unborn", "recovering"] {
        let directory = fixture_root.join(scenario);
        let commit = fixture(&directory, scenario);
        let head = directory.join(".git/HEAD");
        let healthy = if scenario == "recovering" {
            let bytes = std::fs::read(&head).unwrap();
            std::fs::write(&head, "not a valid git HEAD\n").unwrap();
            Some(bytes)
        } else {
            None
        };
        let first = host.sample(&directory, scenario, true, false);
        if scenario == "unborn" {
            assert!(first["identity"].as_str().unwrap().starts_with("dir:"));
            git(
                &directory,
                &["update-ref", "refs/heads/main", commit.as_deref().unwrap()],
            );
        }
        if let Some(bytes) = healthy {
            assert_eq!(first["error"], "git_identity_unavailable");
            assert!(!first["prefix"]
                .as_str()
                .unwrap()
                .contains("standalone memory for"));
            std::fs::write(&head, bytes).unwrap();
        }
        let second = host.sample(&directory, scenario, false, scenario == "recovering");
        if scenario != "plain" {
            assert_eq!(second["identity"], format!("git:{}", commit.unwrap()));
        }
        assert!(second["prefix"]
            .as_str()
            .unwrap()
            .contains("standalone memory for"));
        transcript.extend([first, second]);
    }
    // These refusals predate registered projects. A TypeScript-style fallback
    // would change standalone Rust behavior even when no daemon is configured.
    let missing = fixture_root.join("missing");
    let not_directory = fixture_root.join("file");
    std::fs::write(&not_directory, "not a directory").unwrap();
    for (scenario, directory) in [("missing", missing), ("not-directory", not_directory)] {
        let sample = host.sample(&directory, scenario, true, false);
        assert_eq!(sample["error"], "project_identity_unreadable");
        assert_eq!(sample["identity"], Value::Null);
        transcript.push(sample);
    }
    use std::os::unix::fs::PermissionsExt;
    let unreadable = fixture_root.join("unreadable");
    std::fs::create_dir_all(&unreadable).unwrap();
    std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000)).unwrap();
    // Privileged test runners can still read mode-000 directories.
    if std::fs::read_dir(&unreadable).is_err() {
        let sample = host.sample(&unreadable, "unreadable", true, false);
        assert_eq!(sample["error"], Value::Null);
        assert!(sample["identity"].as_str().unwrap().starts_with("dir:"));
        transcript.push(sample);
    }
    std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let sidecars = isolation.join("cortexkit/magic-context/project-identities");
    let entries: Vec<_> = std::fs::read_dir(sidecars)
        .expect("resolver's legacy git records")
        .collect();
    assert!(
        !entries.is_empty(),
        "must observe the actual legacy git writes"
    );
    for entry in entries {
        let entry = entry.unwrap();
        let record: Value = serde_json::from_slice(&std::fs::read(entry.path()).unwrap()).unwrap();
        assert!(!record["identity"].as_str().unwrap().starts_with("pj-"));
    }
    transcript
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn standalone_identity_and_prefix_bytes_match_the_pre_campaign_base() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let base = std::fs::read_to_string(repo.join(".github/standalone-differential-base"))
        .expect("read pinned standalone differential baseline");
    let base = base
        .lines()
        .find(|line| {
            let line = line.trim();
            !line.is_empty() && !line.starts_with('#')
        })
        .expect("pinned standalone differential baseline commit")
        .trim();
    let available = Command::new("git")
        .args(["cat-file", "-e", &format!("{base}^{{commit}}")])
        .current_dir(&repo)
        .output()
        .expect("run git to check the pinned standalone differential baseline");
    assert!(
        available.status.success(),
        "Standalone differential baseline {base} is missing. Fetch it with: git fetch --no-tags --depth=1 origin {base}"
    );
    let temporary_root = std::env::temp_dir().join("magic-context");
    std::fs::create_dir_all(&temporary_root).unwrap();
    let scratch = tempfile::Builder::new()
        .prefix("standalone-")
        .tempdir_in(temporary_root)
        .unwrap();
    let libraries = host_libraries(&repo);
    let base = compile_host(&repo, &scratch.path().join("base"), Some(base), &libraries);
    let head = compile_host(&repo, &scratch.path().join("head"), None, &libraries);
    for mode in ["no-connection", "daemon-down", "module-absent"] {
        let root = scratch.path().join(mode);
        std::fs::create_dir_all(&root).unwrap();
        let fake = match mode {
            "module-absent" => Some(absent_module(&root).await),
            "daemon-down" => {
                let mut stopped = absent_module(&root).await;
                stopped.task.abort();
                // Await cancellation so the listener is closed before the host connects.
                let _ = (&mut stopped.task).await;
                None
            }
            _ => None,
        };
        let connection = fake
            .as_ref()
            .map(|fake| fake.connection.clone())
            .unwrap_or_else(|| root.join("connection.json"));
        let fixture_root = root.join("fixture");
        let expected = transcript(&base, &fixture_root, &connection, &root.join("base-host"));
        let actual = transcript(&head, &fixture_root, &connection, &root.join("head-host"));
        assert_eq!(
            actual, expected,
            "standalone form {mode}: identities and actual m0 bytes"
        );
        assert!(matches!(actual.len(), 10 | 11));
        if let Some(fake) = fake {
            assert_eq!(
                fake.calls.load(Ordering::SeqCst),
                4,
                "only session starts resolve"
            );
        }
    }
}
