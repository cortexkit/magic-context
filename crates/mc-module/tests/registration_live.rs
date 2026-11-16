//! Both registration paths of the real ck-mc binary, against the real daemon.
//!
//! The daemon starts ck-mc either with a private registration channel it
//! hands over at spawn (ck-mc's manifest declares `registration_channel`), or,
//! when a launcher withholds that channel, with only a launch nonce: ck-mc
//! then dials the daemon and presents the nonce in HELLO. On the channel path
//! every outbound connection ck-mc opens must first present a self claim,
//! which the SDK mints on ck-mc's own module connection. The claim's answer
//! arrives on the same connection the daemon uses to send `route.bind` and
//! `health.check`, so a module whose frame reader waited on its own handler
//! would time every bind out, and every outbound call with it.
//!
//! These tests drive exactly that traffic: compaction routes opened together,
//! a health probe while their binds are in flight and another after them, a
//! catalog read on a tool route, and a Setup that makes ck-mc call the
//! session's runner back on a route of its own. Each answer must arrive well
//! inside the daemon's own budget.
//!
//! Each test boots its own daemon in this process, with its data, runtime,
//! config and module homes, and ck-mc's stores, fenced into a scratch
//! directory under the temporary directory, so nothing touches the
//! operator's daemon, homes or stores.
#![cfg(unix)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
use cortexkit_role_compaction::{ops, wire, COMPACTION_ROLE};
use cortexkit_test_support::{fenced_subc_daemon_env, fenced_subc_env_dir, ScratchDir};
use serde_json::{json, Value};
use subc_control::{ClientControlRequest, ClientControlResponse, ConsumerIdentity};
use subc_protocol::manifest::{
    Concurrency, IdentityScope, ManagementOperation, ManagementOperationKind, ModuleManifest,
    ProviderRole,
};
use subc_protocol::session::ModuleControlResponse;
use subc_protocol::{
    BindIdentity, ErrorBody, Flags, Frame, FrameType, Principal, Priority, RouteTarget,
    PROTOCOL_VERSION,
};
use subc_transport::{authenticate_client, connection_file, read_frame, write_frame};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{sleep, timeout};

/// The module id ck-mc serves as, and the one its routes name.
const PROVIDER: &str = "magic-context";
/// A runner this test plays: the daemon launches a nonce holder under this id,
/// and the test registers it with that nonce.
const RUNNER: &str = "mc-live-runner";
/// The harness the compaction routes are bound to. ck-mc reads the harness
/// `runner` as a route that names no session.
const HARNESS: &str = "registration-live";
/// How many compaction routes open at once, as runners reconnecting after a
/// restart open them.
const ROUTES: usize = 4;
/// The daemon allows a module 12 s to acknowledge `route.bind` and 5 s to
/// answer `health.check`. A module whose frame reader never waits on its own
/// handlers answers in milliseconds; this bound leaves ample room for a
/// loaded build machine while staying far below the point where queued binds
/// start timing out.
const ANSWER_BUDGET: Duration = Duration::from_secs(2);
/// A generous bound that only detects a wait that never ends. Timing claims
/// are [`ANSWER_BUDGET`]'s.
const HANG_GUARD: Duration = Duration::from_secs(60);

fn control_flags() -> Flags {
    Flags::new(false, Priority::Passive, false)
}

async fn connect(connection: &subc_transport::ConnectionInfo) -> TcpStream {
    let endpoint = connection.endpoints.first().expect("an endpoint");
    let mut stream = TcpStream::connect(format!("{}:{}", endpoint.host, endpoint.port))
        .await
        .expect("connect to the daemon");
    authenticate_client(&mut stream, connection, HANG_GUARD)
        .await
        .expect("authenticate");
    stream
}

async fn next_frame(stream: &mut TcpStream) -> Frame {
    timeout(HANG_GUARD, read_frame(stream))
        .await
        .expect("the daemon answers")
        .expect("readable frame")
        .expect("connection open")
}

/// Send one client control request and wait for its answer.
async fn client_request(stream: &mut TcpStream, corr: u64, request: ClientControlRequest) -> Frame {
    let frame = Frame::build(
        FrameType::Request,
        control_flags(),
        0,
        0,
        corr,
        serde_json::to_vec(&request).unwrap(),
    )
    .unwrap();
    write_frame(stream, &frame).await.expect("write request");
    loop {
        let reply = next_frame(stream).await;
        if reply.header.channel == 0 && reply.header.corr == corr {
            return reply;
        }
    }
}

/// Send one request on a route and wait for its answer.
async fn route_call(
    client: &mut TcpStream,
    channel: u16,
    epoch: u32,
    corr: u64,
    body: Vec<u8>,
) -> Frame {
    let frame = Frame::build(
        FrameType::Request,
        control_flags(),
        channel,
        epoch,
        corr,
        body,
    )
    .unwrap();
    write_frame(client, &frame)
        .await
        .expect("write route request");
    loop {
        let reply = next_frame(client).await;
        if (reply.header.channel, reply.header.corr) == (channel, corr) {
            return reply;
        }
    }
}

fn reserved(module_id: &str) -> Principal {
    Principal::Reserved {
        module_id: module_id.into(),
    }
}

/// The runner's manifest: a management surface for the calls a compaction
/// provider makes back to a session's runner.
fn runner_manifest() -> ModuleManifest {
    let operation = |name: &str, kind| ManagementOperation {
        name: name.into(),
        kind,
        description: None,
    };
    ModuleManifest::builder(RUNNER, "0.0.0")
        .provides(vec![ProviderRole::ManagementSurface {
            operations: vec![
                operation("role.describe", ManagementOperationKind::Query),
                operation(ops::SESSION_ENTRIES, ManagementOperationKind::Query),
                operation(ops::SESSION_APPLIED_VIEW, ManagementOperationKind::Query),
                operation(ops::SESSION_APPLY_VIEW, ManagementOperationKind::Mutate),
                operation(ops::SESSION_SEND, ManagementOperationKind::Mutate),
                operation(ops::RUN_RESULT, ManagementOperationKind::Query),
            ],
            config_schema: json!({}),
            observability: vec![],
            identity_scope: vec![IdentityScope::Session],
            concurrency: Concurrency::ModuleManaged,
        }])
        .build()
}

/// The runner, registered by this test with the nonce the daemon handed its
/// launched stand-in. It acknowledges every bind and records each one,
/// answers health, and refuses every request on a route, so a call ck-mc
/// makes back is answered at once rather than left to time out.
struct Registered {
    binds: tokio::sync::Mutex<mpsc::UnboundedReceiver<Value>>,
}

impl Registered {
    async fn register(
        connection: &subc_transport::ConnectionInfo,
        nonce: &str,
        manifest: ModuleManifest,
    ) -> Self {
        let module_id = manifest.module_id.clone();
        let mut stream = connect(connection).await;
        let hello = json!({
            "manifest": manifest,
            "protocol_ver": PROTOCOL_VERSION,
            "control_ops": ["route.bind", "health.check"],
            "launch_nonce": nonce,
        });
        let frame = Frame::build(
            FrameType::Hello,
            control_flags(),
            0,
            0,
            1,
            serde_json::to_vec(&hello).unwrap(),
        )
        .unwrap();
        write_frame(&mut stream, &frame).await.expect("HELLO");
        let ack = next_frame(&mut stream).await;
        assert_eq!(
            ack.header.ty,
            FrameType::HelloAck,
            "{module_id}'s HELLO was refused: {}",
            String::from_utf8_lossy(&ack.body)
        );
        let (mut reader, mut writer_half) = tokio::io::split(stream);
        let (replies, mut outgoing) = mpsc::unbounded_channel::<Frame>();
        let (bound, binds) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(frame) = outgoing.recv().await {
                if write_frame(&mut writer_half, &frame).await.is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            while let Ok(Some(frame)) = read_frame(&mut reader).await {
                let header = frame.header;
                let reply = match (header.ty, header.channel) {
                    (FrameType::Ping, 0) => Some((FrameType::Pong, Vec::new())),
                    (FrameType::Request, 0) => {
                        let body: Value = serde_json::from_slice(&frame.body).unwrap_or_default();
                        Some(match body["op"].as_str() {
                            Some("health.check") => (
                                FrameType::Response,
                                serde_json::to_vec(
                                    &json!({"op": "health.check", "status": "healthy"}),
                                )
                                .unwrap(),
                            ),
                            Some("route.bind") => {
                                let _ = bound.send(body);
                                (
                                    FrameType::Response,
                                    serde_json::to_vec(&ModuleControlResponse::RouteBindAck {})
                                        .unwrap(),
                                )
                            }
                            _ => (
                                FrameType::Error,
                                serde_json::to_vec(&ErrorBody::new(
                                    "unsupported",
                                    "the registration live runner serves binds and health only",
                                ))
                                .unwrap(),
                            ),
                        })
                    }
                    (FrameType::Request, _) => Some((
                        FrameType::Error,
                        serde_json::to_vec(&ErrorBody::new(
                            "unavailable",
                            "the registration live runner answers no calls",
                        ))
                        .unwrap(),
                    )),
                    _ => None,
                };
                let Some((ty, body)) = reply else { continue };
                let reply = Frame::build(
                    ty,
                    control_flags(),
                    header.channel,
                    header.epoch,
                    header.corr,
                    body,
                )
                .unwrap();
                if replies.send(reply).is_err() {
                    break;
                }
            }
        });
        Self {
            binds: tokio::sync::Mutex::new(binds),
        }
    }
}

/// A built binary, copied to a `ckdev-` name under the temporary directory.
/// Shipped modules run as `ck-<name>` executables; the copy keeps a test's
/// processes from showing up under a shipped module's name in a process
/// list, and keeps the daemon from launching anything from the build tree.
fn staged(built: &str) -> PathBuf {
    cortexkit_test_support::ckdev_binary(built)
}

/// The environment every module the daemon starts gets: homes, temporary
/// directory and ck-mc's stores and config, all inside `scratch`. The daemon
/// passes its own environment through to the modules it starts, so every
/// variable ck-mc reads a store or config location from is set here, whatever
/// the test process inherited.
fn fenced_module_env(scratch: &Path) -> BTreeMap<String, PathBuf> {
    let mut env: BTreeMap<String, PathBuf> = fenced_subc_daemon_env(scratch)
        .into_iter()
        .map(|(name, path)| {
            (
                name.into_string().expect("fenced variable name is UTF-8"),
                PathBuf::from(path),
            )
        })
        .collect();
    let stores = scratch.join("magic-context");
    fs::create_dir_all(&stores).unwrap();
    env.insert("MAGIC_CONTEXT_DB".into(), stores.join("context.db"));
    env.insert("MAGIC_CONTEXT_MODE3_STORE".into(), stores.join("mode3.db"));
    env.insert("MAGIC_CONTEXT_STORAGE_DIR".into(), stores.clone());
    env.insert("MAGIC_CONTEXT_TEST_DATA_DIR".into(), stores.clone());
    env.insert(
        "MAGIC_CONTEXT_CONFIG_PATH".into(),
        scratch.join("config/magic-context.jsonc"),
    );
    env
}

struct Fixture {
    /// Removed when the test passes; kept, with the daemon's and ck-mc's
    /// logs, when it fails.
    _directory: ScratchDir,
    daemon: tokio::task::JoinHandle<Result<(), subc_daemon::bootstrap::BootstrapError>>,
    connection: subc_transport::ConnectionInfo,
    runner_nonce: String,
    runner: Registered,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.daemon.abort();
    }
}

async fn read_nonce(directory: &Path, id: &str) -> String {
    timeout(HANG_GUARD, async {
        loop {
            if let Ok(nonce) = fs::read_to_string(directory.join(format!("{id}-nonce"))) {
                if !nonce.is_empty() {
                    break nonce;
                }
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the daemon spawns {id}, which hands over its nonce"))
}

impl Fixture {
    async fn start(registration_channel: bool) -> Self {
        let directory = ScratchDir::new("mc-registration-live");
        let module_env = fenced_module_env(directory.path());
        let data = fenced_subc_env_dir(directory.path(), "XDG_DATA_HOME");
        let run = data.join("cortexkit/run");
        let connection_path = directory.join("subc-connection.json");
        let daemon_path = directory.join("subc.jsonc");
        let mut modules = serde_json::Map::new();
        let mut holder_env = module_env.clone();
        holder_env.insert(
            "NONCE_OUT".into(),
            directory.join(format!("{RUNNER}-nonce")),
        );
        modules.insert(
            RUNNER.into(),
            json!({"program": staged(env!("CARGO_BIN_EXE_mc-test-nonce-holder")),
                "env": holder_env, "reserved": true}),
        );
        // This daemon hands every module it starts a registration channel.
        // The channel launch runs ck-mc directly, so it adopts that channel.
        // The nonce launch runs it under a launcher that withholds the
        // channel, as a daemon that offers none would, so it dials the daemon
        // and presents its launch nonce.
        let ck_mc = staged(env!("CARGO_BIN_EXE_ck-mc"));
        let provider = if registration_channel {
            json!({"program": ck_mc, "env": module_env, "reserved": true,
                "registration_channel": true})
        } else {
            let mut launcher_env = module_env.clone();
            launcher_env.insert("NONCE_LAUNCH_PROGRAM".into(), ck_mc);
            json!({"program": staged(env!("CARGO_BIN_EXE_mc-test-nonce-launcher")),
                "env": launcher_env, "reserved": true})
        };
        modules.insert(PROVIDER.into(), provider);
        fs::write(
            &daemon_path,
            serde_json::to_vec(&json!({"version": 1, "modules": modules})).unwrap(),
        )
        .unwrap();
        let daemon_config = subc_daemon::bootstrap::BootstrapConfig::new(&connection_path, 0)
            .with_privacy_trampoline(staged(env!("CARGO_BIN_EXE_mc-test-privacy-trampoline")))
            .with_daemon_config_path(&daemon_path)
            .unwrap()
            .with_capture_logs_dir(run.join("logs"))
            .with_terminal_journal_path(run.join("terminals.jsonl"))
            .with_live_children_record(run.join("live-children.json"))
            .with_machine_id_path(data.join("cortexkit/machine-id"));
        let daemon = tokio::spawn(subc_daemon::bootstrap::run_with_config(daemon_config));
        let connection = timeout(HANG_GUARD, async {
            loop {
                if let Ok(connection) = connection_file::read(&connection_path) {
                    break connection;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the daemon publishes its connection file");
        let runner_nonce = read_nonce(directory.path(), RUNNER).await;
        let runner = Registered::register(&connection, &runner_nonce, runner_manifest()).await;
        let fixture = Self {
            _directory: directory,
            daemon,
            connection,
            runner_nonce,
            runner,
        };
        fixture.await_registration(registration_channel).await;
        fixture
    }

    /// Wait until the daemon lists ck-mc, then check which path it used.
    async fn await_registration(&self, registration_channel: bool) {
        timeout(HANG_GUARD, async {
            loop {
                let mut probe = connect(&self.connection).await;
                let catalog = client_request(
                    &mut probe,
                    3,
                    ClientControlRequest::CatalogList {
                        module_id: Some(PROVIDER.into()),
                    },
                )
                .await;
                if String::from_utf8_lossy(&catalog.body).contains(&format!("\"{PROVIDER}\"")) {
                    break;
                }
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("supervised ck-mc registers");
        let mut probe = connect(&self.connection).await;
        let provenance = client_request(
            &mut probe,
            4,
            ClientControlRequest::SupervisorProvenance {
                module_id: Some(PROVIDER.into()),
            },
        )
        .await;
        let body: Value = serde_json::from_slice(&provenance.body).unwrap();
        let entry = body["modules"]
            .as_array()
            .and_then(|modules| {
                modules
                    .iter()
                    .find(|module| module["module_id"] == PROVIDER)
            })
            .unwrap_or_else(|| panic!("provenance lists ck-mc: {body}"));
        let expected = if registration_channel {
            "channel"
        } else {
            "nonce"
        };
        assert_eq!(
            entry["registration"], expected,
            "the daemon registered ck-mc on the path this test configured: {entry}"
        );
    }

    /// Open a route to ck-mc as the runner, for `role` and bound to `harness`
    /// and `session`, the way a runner's session does. Returns how long the
    /// daemon took to answer, which includes ck-mc's acknowledgement of the
    /// bind.
    async fn open_route(
        &self,
        role: (&str, &str),
        harness: &str,
        session: &str,
    ) -> (Duration, Result<(TcpStream, u16, u32), String>) {
        let mut client = connect(&self.connection).await;
        let started = Instant::now();
        let reply = client_request(
            &mut client,
            7,
            ClientControlRequest::RouteOpen {
                busy_refusals: None,
                role_versions: Some(BTreeMap::from([(role.0.to_owned(), role.1.to_owned())])),
                target: RouteTarget::ToolProvider {
                    module_id: PROVIDER.into(),
                },
                identity: BindIdentity::new(harness, session),
                consumer_identity: Some(ConsumerIdentity {
                    module_id: RUNNER.into(),
                    launch_nonce: self.runner_nonce.clone(),
                }),
                consumer_capabilities: None,
                admission_facts: None,
                scope: None,
            },
        )
        .await;
        let elapsed = started.elapsed();
        if reply.header.ty != FrameType::Response {
            return (
                elapsed,
                Err(String::from_utf8_lossy(&reply.body).into_owned()),
            );
        }
        match serde_json::from_slice::<ClientControlResponse>(&reply.body).unwrap() {
            ClientControlResponse::RouteOpen {
                route_channel,
                route_epoch,
                ..
            } => (elapsed, Ok((client, route_channel, route_epoch))),
            other => (
                elapsed,
                Err(format!("unexpected route.open reply {other:?}")),
            ),
        }
    }

    /// Ask the daemon to send ck-mc `health.check` now.
    async fn health(&self) -> (Duration, Value) {
        let mut client = connect(&self.connection).await;
        let started = Instant::now();
        let reply = client_request(
            &mut client,
            9,
            ClientControlRequest::SupervisorHealthProbe {
                module_id: PROVIDER.into(),
            },
        )
        .await;
        let elapsed = started.elapsed();
        let mut body: Value = serde_json::from_slice(&reply.body).unwrap_or_default();
        body["frame"] = json!(format!("{:?}", reply.header.ty));
        (elapsed, body)
    }
}

/// Binds, health, a catalog read and an outbound route, all answered promptly.
async fn serves_binds_health_and_outbound_routes(registration_channel: bool) {
    let fixture = Arc::new(Fixture::start(registration_channel).await);
    let path = if registration_channel {
        "channel"
    } else {
        "nonce"
    };

    // Compaction routes open together while the daemon probes health.
    let mut opens = tokio::task::JoinSet::new();
    for session in 0..ROUTES {
        let fixture = Arc::clone(&fixture);
        opens.spawn(async move {
            let session = format!("session-{session}");
            let opened = fixture.open_route(COMPACTION_ROLE, HARNESS, &session).await;
            (session, opened)
        });
    }
    let probe = {
        let fixture = Arc::clone(&fixture);
        tokio::spawn(async move {
            // Let the binds reach the module first, so the probe queues behind them.
            sleep(Duration::from_millis(100)).await;
            fixture.health().await
        })
    };
    let mut routes = Vec::new();
    while let Some(opened) = opens.join_next().await {
        let (session, (elapsed, result)) = opened.unwrap();
        let route = result.unwrap_or_else(|error| {
            panic!("a compaction route.open failed after {elapsed:?}: {error}")
        });
        eprintln!("{path} launch: compaction route.bind acknowledged in {elapsed:?}");
        assert!(
            elapsed < ANSWER_BUDGET,
            "ck-mc acknowledged a compaction route.bind only after {elapsed:?}"
        );
        routes.push((session, route));
    }
    let (elapsed, health) = probe.await.unwrap();
    eprintln!("{path} launch: health.check during the binds answered in {elapsed:?}");
    assert_eq!(health["frame"], "Response", "{health}");
    assert!(
        elapsed < ANSWER_BUDGET,
        "health.check answered only after {elapsed:?}: {health}"
    );

    // Health once more after the binds, as the daemon's periodic probe does.
    let (elapsed, health) = fixture.health().await;
    eprintln!("{path} launch: health.check after the binds answered in {elapsed:?}");
    assert_eq!(health["frame"], "Response", "{health}");
    assert!(
        elapsed < ANSWER_BUDGET,
        "health.check answered only after {elapsed:?}: {health}"
    );

    // A catalog read on a tool route that names no session, as core lists a
    // head's tools: a request ck-mc answers from its own frame handler.
    let (elapsed, tools) = fixture
        .open_route(
            (
                cortexkit_role_tool_provider::ROLE,
                cortexkit_role_tool_provider::VERSION,
            ),
            "runner",
            "catalog",
        )
        .await;
    let (mut client, channel, epoch) = tools
        .unwrap_or_else(|error| panic!("the tool route.open failed after {elapsed:?}: {error}"));
    let started = Instant::now();
    let catalog = route_call(
        &mut client,
        channel,
        epoch,
        100,
        serde_json::to_vec(&json!({"name": "tool.catalog", "arguments": {}})).unwrap(),
    )
    .await;
    let elapsed = started.elapsed();
    eprintln!("{path} launch: tool.catalog answered in {elapsed:?}");
    assert_eq!(
        catalog.header.ty,
        FrameType::Response,
        "tool.catalog: {}",
        String::from_utf8_lossy(&catalog.body)
    );
    let catalog: cortexkit_role_tool_provider::catalog::CatalogAnswer =
        serde_json::from_slice(&catalog.body).expect("tool.catalog answers a catalog");
    eprintln!(
        "{path} launch: tool.catalog listed {} tools",
        catalog.tools.len()
    );
    assert!(
        elapsed < ANSWER_BUDGET,
        "tool.catalog answered only after {elapsed:?}"
    );

    // A Setup on one compaction route. ck-mc answers it at once, then its
    // session asks the runner what it supports, on a route ck-mc opens to the
    // runner's management surface. The runner sees that bind only if ck-mc's
    // outbound connection was admitted as ck-mc: with a self claim on the
    // channel path, with its launch nonce on the nonce path.
    let (session, (client, channel, epoch)) = routes.first_mut().expect("a compaction route");
    let setup = SetupRequest::new(
        "head",
        ModelRef::new("test", "model"),
        1_000_000,
        128_000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        vec![],
        1,
    );
    let started = Instant::now();
    let reply = route_call(
        client,
        *channel,
        *epoch,
        101,
        wire::encode(ops::COMPACTION_SETUP, &setup),
    )
    .await;
    let elapsed = started.elapsed();
    eprintln!("{path} launch: compaction.setup answered in {elapsed:?}");
    assert_eq!(
        reply.header.ty,
        FrameType::Response,
        "compaction.setup: {}",
        String::from_utf8_lossy(&reply.body)
    );
    assert!(
        elapsed < ANSWER_BUDGET,
        "compaction.setup answered only after {elapsed:?}"
    );
    let started = Instant::now();
    let bind = timeout(HANG_GUARD, async {
        fixture.runner.binds.lock().await.recv().await
    })
    .await
    .expect("ck-mc opens a route to the runner after Setup")
    .expect("runner connection open");
    eprintln!(
        "{path} launch: ck-mc's route to the runner bound {:?} after Setup's answer",
        started.elapsed()
    );
    assert_eq!(
        bind["principal"],
        serde_json::to_value(reserved(PROVIDER)).unwrap(),
        "the daemon stamped ck-mc's own outbound route as ck-mc: {bind}"
    );
    assert_eq!(
        (&bind["identity"]["harness"], &bind["identity"]["session"]),
        (&json!(HARNESS), &json!(session)),
        "ck-mc bound its route to the runner to the session it was set up for: {bind}"
    );

    // ck-mc still answers health after its outbound route opened.
    let (elapsed, health) = fixture.health().await;
    assert_eq!(health["frame"], "Response", "{health}");
    assert!(
        elapsed < ANSWER_BUDGET,
        "health.check answered only after {elapsed:?}: {health}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn channel_launch_answers_binds_health_and_opens_claimed_routes() {
    serves_binds_health_and_outbound_routes(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nonce_launch_answers_binds_health_and_opens_attested_routes() {
    serves_binds_health_and_outbound_routes(false).await;
}
