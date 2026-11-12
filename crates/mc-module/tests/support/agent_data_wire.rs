//! Agent-data moves over the real wire. Two throwaway subc daemons stand
//! for two machines. Each runs ck-mc, the mock runner and stand-ins for
//! Entorhinal and Engram's session door, every one a module the daemon
//! launched. The stand-ins are this test binary, launched again by the
//! daemon ([`stand_in_module`]), so they are attested as `entorhinal` and
//! `engram` exactly as the real modules would be. Both machines' doors keep
//! their streams in one shared folder, as Engram's cloud would carry them
//! from one machine to the other.
//!
//! The suite checks what only the wire shows: that ck-mc admits the
//! driver by the caller the daemon stamped, reaches the door as an internal
//! service, encodes every reply as the contract crate does, and puts its
//! refusals on the wire with their codes. Which rows end up where is the
//! in-process tests' subject; here it is checked once, end to end.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use cortexkit_role_agent_data as contract;
use cortexkit_role_compaction::read::SessionRef;
use cortexkit_role_compaction::wire;
use mc_mock_runner::runner::Report;
use mc_mock_runner::script::Step;
use mc_mock_runner::subc::{PlayRequest, MOCK_PLAY};
use mc_module::agent_data::door::{hex, unhex};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use subc_client_rs::{
    async_trait, BindDecision, CallOptions, ConsumerOptions, HandlerOutcome, ModuleHandler,
    RequestCtx, RouteBindRequest, SubcConsumer,
};
use subc_protocol::manifest::{
    Concurrency, IdentityScope, InternalTransport, ManagementOperation, ManagementOperationKind,
    ModuleManifest, ProviderRole,
};
use subc_protocol::{BindIdentity, RouteTarget, SUBC_MODULE_ID_ENV};

use super::{answer, dev_copy, required_binary, spawn, Process, Root, COUNTER, START_TIMEOUT};

/// Which stand-in a copy of this binary the daemon launched serves:
/// `entorhinal` or `engram`.
const STAND_IN: &str = "MC_WIRE_STAND_IN";
/// The daemon's connection file, for a stand-in to connect with.
const STAND_IN_CONNECTION: &str = "MC_WIRE_STAND_IN_CONNECTION";
/// The folder both machines' stand-ins share: Entorhinal's bindings and
/// the door's streams and sealed cuts.
const STAND_IN_SHARED: &str = "MC_WIRE_STAND_IN_SHARED";
/// The full name of [`stand_in_module`], which the daemon runs alone.
const STAND_IN_TEST: &str = "agent_data_wire::stand_in_module";

const PROVIDER: &str = "magic-context";
/// The mock runner runs under Broca's module id: ck-mc resolves a
/// `broca-session` ref only to a session of the module that owns the kind.
const RUNNER: &str = "broca";
const HARNESS: &str = "mock";
const KIND: &str = "broca-session";
const PROJECT: &str = "git:wire-project";

/// The method of the stand-in Entorhinal's own management op that sends
/// one agent-data request to ck-mc and answers with ck-mc's reply.
const DRIVE: &str = "wire.agent_data";

/// Not a test of its own: the stand-in modules' entry point. The daemon
/// launches this test binary again with this test's name and the
/// environment above, and the test then serves until the daemon goes
/// away. Run any other way, as by the suite itself, it returns at once.
#[test]
fn stand_in_module() {
    let Ok(role) = std::env::var(STAND_IN) else {
        return;
    };
    // Before anything could start a process that would inherit the launch
    // nonce's descriptor.
    let _ = subc_client_rs::launch_nonce();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(serve_stand_in(role));
}

async fn serve_stand_in(role: String) {
    let connection_file = PathBuf::from(std::env::var(STAND_IN_CONNECTION).unwrap());
    let shared = PathBuf::from(std::env::var(STAND_IN_SHARED).unwrap());
    let module_id = std::env::var(SUBC_MODULE_ID_ENV).unwrap();
    let role = match role.as_str() {
        "entorhinal" => Role::Entorhinal,
        "engram" => Role::Engram,
        other => panic!("no stand-in is called {other}"),
    };
    let manifest = match role {
        Role::Entorhinal => entorhinal_manifest(&module_id),
        Role::Engram => engram_manifest(&module_id),
    };
    let handler = StandIn {
        role,
        shared,
        connection_file: connection_file.clone(),
        consumer: tokio::sync::OnceCell::new(),
        door: Mutex::new(()),
    };
    let (_handle, serve) = subc_client_rs::serve_with_handle(&connection_file, manifest, handler)
        .await
        .unwrap();
    // The daemon going away ends the connection, and with it this process.
    let _ = serve.await;
}

#[derive(Clone, Copy)]
enum Role {
    Entorhinal,
    Engram,
}

fn entorhinal_manifest(module_id: &str) -> ModuleManifest {
    let operation = |name: &str, kind| ManagementOperation {
        name: name.into(),
        kind,
        description: None,
    };
    ModuleManifest::builder(module_id, env!("CARGO_PKG_VERSION"))
        .provides(vec![ProviderRole::ManagementSurface {
            operations: vec![
                operation("agent.session_for_ref", ManagementOperationKind::Query),
                operation("context.project", ManagementOperationKind::Query),
                operation("context.session", ManagementOperationKind::Query),
                operation(DRIVE, ManagementOperationKind::Mutate),
            ],
            config_schema: json!({}),
            observability: vec![],
            identity_scope: vec![IdentityScope::Session],
            concurrency: Concurrency::ModuleManaged,
        }])
        .build()
}

fn engram_manifest(module_id: &str) -> ModuleManifest {
    ModuleManifest::builder(module_id, env!("CARGO_PKG_VERSION"))
        .provides(vec![ProviderRole::InternalService {
            service_id: "session-door".into(),
            transport: InternalTransport::Bulk,
            agent_facing: false,
            operations: [
                "session.offsets",
                "session.cover",
                "session.admit",
                "session.digest",
                "session.read",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        }])
        .build()
}

/// A refusal a stand-in answers with: its code, message and detail.
struct Refused {
    code: String,
    message: String,
    detail: Option<Value>,
}

fn refused(code: &str, message: impl Into<String>, detail: Option<Value>) -> Refused {
    Refused {
        code: code.to_owned(),
        message: message.into(),
        detail,
    }
}

struct StandIn {
    role: Role,
    shared: PathBuf,
    connection_file: PathBuf,
    /// The stand-in Entorhinal's own connection, for its calls to ck-mc.
    consumer: tokio::sync::OnceCell<SubcConsumer>,
    /// One door call at a time reads and writes the door's files.
    door: Mutex<()>,
}

#[async_trait]
impl ModuleHandler for StandIn {
    async fn on_bind(&self, request: &RouteBindRequest) -> BindDecision {
        match (self.role, &request.target) {
            (Role::Engram, RouteTarget::InternalService { service_id, .. })
                if service_id == "session-door" =>
            {
                BindDecision::accept()
            }
            (Role::Entorhinal, RouteTarget::ManagementSurface { .. }) => BindDecision::accept(),
            _ => BindDecision::reject(
                "unknown_service",
                "this stand-in serves only its own surface",
            ),
        }
    }

    async fn handle(&self, _ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome {
        let answer = match serde_json::from_slice::<Value>(&body) {
            Ok(request) => {
                let method = request["method"].as_str().unwrap_or_default().to_owned();
                let params = request.get("params").cloned().unwrap_or(Value::Null);
                match self.role {
                    Role::Engram => self.door(&method, &params),
                    Role::Entorhinal => self.entorhinal(&method, params).await,
                }
            }
            Err(error) => Err(refused("invalid_request", error.to_string(), None)),
        };
        match answer {
            Ok(result) => {
                HandlerOutcome::Response(serde_json::to_vec(&json!({"result": result})).unwrap())
            }
            Err(Refused {
                code,
                message,
                detail: Some(detail),
            }) => HandlerOutcome::ErrorWithDetail {
                code,
                message,
                detail,
            },
            Err(Refused { code, message, .. }) => HandlerOutcome::Error { code, message },
        }
    }
}

impl StandIn {
    /// Entorhinal: ref lookups from the bindings the test wrote, no memory
    /// context, and the driver's op, which sends one agent-data request to
    /// ck-mc as Entorhinal's own call.
    async fn entorhinal(&self, method: &str, params: Value) -> Result<Value, Refused> {
        match method {
            "agent.session_for_ref" => {
                let bindings: Value = serde_json::from_slice(
                    &std::fs::read(self.shared.join("bindings.json")).unwrap(),
                )
                .unwrap();
                let reference = params["ref"].as_str().unwrap_or_default();
                match bindings.get(reference) {
                    Some(binding) if binding["ref_kind"] == params["ref_kind"] => {
                        Ok(binding.clone())
                    }
                    _ => Err(refused(
                        "not_found",
                        "no agent session is registered under this reference",
                        None,
                    )),
                }
            }
            DRIVE => {
                let consumer = self
                    .consumer
                    .get_or_try_init(|| {
                        SubcConsumer::connect(&self.connection_file, ConsumerOptions::default())
                    })
                    .await
                    .map_err(|error| refused("unavailable", format!("{error:?}"), None))?;
                let reply = consumer
                    .call(
                        RouteTarget::InternalService {
                            module_id: PROVIDER.into(),
                            service_id: contract::SERVICE_ID.into(),
                        },
                        BindIdentity::new("agent-data", "entorhinal"),
                        serde_json::to_vec(&params).unwrap(),
                        CallOptions {
                            timeout: Duration::from_secs(120),
                            // A route the daemon cannot open, as to ck-mc
                            // with moves off, is answered at once instead
                            // of being retried while the test waits.
                            route_retry_deadline: Duration::from_secs(1),
                            ..CallOptions::default()
                        },
                    )
                    .await;
                Ok(match reply {
                    Ok(bytes) => json!({"reply": String::from_utf8(bytes).unwrap()}),
                    Err(subc_client_rs::CallError::Module(body)) => json!({"refused": {
                        "code": body.code,
                        "message": body.message,
                        "detail": body.detail,
                    }}),
                    Err(other) => json!({"failed": format!("{other:?}")}),
                })
            }
            // As Entorhinal does for a read it does not serve: ck-mc then
            // reads its memory context as unanswered, as with no
            // Entorhinal at all.
            other => Err(refused(
                "unknown_method",
                format!("the stand-in Entorhinal does not serve {other}"),
                None,
            )),
        }
    }

    /// Engram's session door over files in the shared folder: one
    /// append-only stream per session, always fully in the cloud with its
    /// floor at 0, and the cuts the test sealed.
    fn door(&self, method: &str, params: &Value) -> Result<Value, Refused> {
        let _one_at_a_time = self.door.lock().unwrap();
        let session = params["sessionRef"]
            .as_str()
            .ok_or_else(|| refused("invalid_request", "no sessionRef", None))?;
        let path = stream_path(&self.shared, session);
        let stream = std::fs::read(&path).unwrap_or_default();
        let offsets = |end: usize| json!({"durableOffset": end, "cloudOffset": end});
        match method {
            "session.offsets" | "session.cover" => Ok(offsets(stream.len())),
            "session.admit" => {
                let from = params["fromOffset"].as_u64().unwrap() as usize;
                if from != stream.len() {
                    return Err(refused(
                        "offset_mismatch",
                        "the stream ends elsewhere",
                        Some(json!({"expectedOffset": stream.len()})),
                    ));
                }
                let bytes = unhex(params["bytes"].as_str().unwrap())
                    .ok_or_else(|| refused("invalid_request", "bytes are not hex", None))?;
                let mut grown = stream;
                grown.extend(bytes);
                std::fs::write(&path, &grown).unwrap();
                Ok(offsets(grown.len()))
            }
            "session.digest" => {
                let end = params["end"].as_u64().unwrap() as usize;
                if end > stream.len() {
                    return Err(refused(
                        "offset_out_of_range",
                        "past the stream's end",
                        Some(json!({"streamEnd": stream.len()})),
                    ));
                }
                Ok(json!({
                    "end": end,
                    "digest": sha256(&stream[..end]),
                    "floor": 0,
                    "midstate": initial_midstate(),
                }))
            }
            "session.read" => {
                let from = params["fromOffset"].as_u64().unwrap() as usize;
                let limit = params["limit"].as_u64().unwrap() as usize;
                let Some(cut) = params.get("cutId").and_then(Value::as_str) else {
                    let bytes = &stream[from..stream.len().min(from + limit)];
                    return Ok(json!({
                        "bytes": hex(bytes),
                        "fromOffset": from,
                        "endOffset": from + bytes.len(),
                        "streamEnd": stream.len(),
                    }));
                };
                let sealed: Value = match std::fs::read(sealed_path(&self.shared, cut, session)) {
                    Ok(bytes) => serde_json::from_slice(&bytes).unwrap(),
                    Err(_) => return Err(refused("not_found", "no such sealed cut", None)),
                };
                let end = sealed["end"].as_u64().unwrap() as usize;
                let bytes = &stream[from..end.min(from + limit)];
                Ok(json!({
                    "bytes": hex(bytes),
                    "fromOffset": from,
                    "endOffset": from + bytes.len(),
                    "streamEnd": end,
                    "digest": sealed["digest"],
                    "floor": 0,
                    "midstate": initial_midstate(),
                }))
            }
            other => Err(refused(
                "invalid_request",
                format!("the stand-in door does not serve {other}"),
                None,
            )),
        }
    }
}

fn stream_path(shared: &Path, session_ref: &str) -> PathBuf {
    shared.join("door").join(format!("{session_ref}.stream"))
}

fn sealed_path(shared: &Path, cut: &str, session_ref: &str) -> PathBuf {
    shared
        .join("door")
        .join(format!("{cut}-{session_ref}.sealed"))
}

/// SHA-256's running state before any byte, as the door encodes it.
fn initial_midstate() -> Value {
    let chaining: Vec<u8> = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ]
    .iter()
    .flat_map(|word| word.to_be_bytes())
    .collect();
    json!({"chaining": hex(&chaining), "tail": ""})
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// One wire test's folder: both machines' folders and the folder their
/// stand-ins share. Kept when the test fails, for the logs.
struct World {
    root: Root,
    shared: PathBuf,
}

impl World {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "mc-wire-move-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let shared = root.join("shared");
        std::fs::create_dir_all(shared.join("door")).unwrap();
        let world = Self {
            root: Root(root),
            shared,
        };
        world.bind(&[]);
        world
    }

    /// Entorhinal's bindings: each session's ref, named like the session,
    /// resolves to the mock runner's session of that id.
    fn bind(&self, sessions: &[&str]) {
        let bindings: serde_json::Map<String, Value> = sessions
            .iter()
            .map(|session| {
                (
                    (*session).to_owned(),
                    json!({
                        "agent_id": "agent_0000000000000101",
                        "ref_kind": KIND,
                        "ref": session,
                        "runner": RUNNER,
                        "harness": HARNESS,
                        "session_id": session,
                        "project_root": null,
                        "incarnation": "0123456789abcdef",
                    }),
                )
            })
            .collect();
        std::fs::write(
            self.shared.join("bindings.json"),
            serde_json::to_vec(&bindings).unwrap(),
        )
        .unwrap();
    }

    /// Seal `cut` from `prepare`'s reply, as Entorhinal does: the door then
    /// serves each session's stream up to the item's end, under the cut.
    fn seal(&self, cut: &str, prepared: &Value) {
        for item in prepared["items"].as_array().unwrap() {
            let session_ref = item["sessionRef"].as_str().unwrap();
            std::fs::write(
                sealed_path(&self.shared, cut, session_ref),
                json!({"end": item["endOffset"], "digest": item["digest"]}).to_string(),
            )
            .unwrap();
        }
    }
}

/// One machine: a daemon of its own, with ck-mc, the mock runner and the
/// two stand-ins, over its own data folder.
struct Machine {
    connection_file: PathBuf,
    context_db: PathBuf,
    _processes: Vec<Process>,
}

/// Create a machine's folders and its empty `context.db`, which a standalone
/// plugin creates in production. Rows a test seeds go in before the daemon
/// starts.
fn prepare_machine(world: &World, name: &str) -> PathBuf {
    let dir = world.root.0.join(name);
    for sub in ["runtime", "config/cortexkit", "data"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    let context_db = context_db_of(&dir);
    std::fs::create_dir_all(context_db.parent().unwrap()).unwrap();
    mc_module::context_db::ContextDb::create_for_tests(&context_db).unwrap();
    dir
}

fn context_db_of(dir: &Path) -> PathBuf {
    dir.join("data/cortexkit/magic-context/context.db")
}

/// A connection to a `context.db` as `ContextDb::open` leaves it, with
/// foreign keys off: the seeds name rows that no longer exist on purpose.
fn open(path: &Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
    conn
}

/// Start the machine in `dir`, with agent-data moves switched on for ck-mc
/// through its environment when `moves` is set and left at the build's
/// default otherwise.
async fn start_machine(world: &World, dir: &Path, label: &'static str, moves: bool) -> Machine {
    let daemon = dev_copy(&required_binary("MC_TEST_CK_SUBC_BIN"), dir, "subc");
    let runner = dev_copy(
        &required_binary("MC_TEST_MOCK_RUNNER_BIN"),
        dir,
        "mock-runner",
    );
    let module = dev_copy(Path::new(env!("CARGO_BIN_EXE_ck-mc")), dir, "mc");
    let stand_in = std::env::current_exe().unwrap();
    let connection_file = dir.join("runtime/subc-connection.json");
    let entry = |program: &Path, args: Value, env: Value| {
        json!({
            "program": program,
            "args": args,
            "env": env,
            "enabled": true,
            "reserved": true,
        })
    };
    let subc_args = json!(["--subc", connection_file]);
    let stand_in_entry = |role: &str| {
        entry(
            &stand_in,
            // The daemon adds `--subc <connection file>` to a module's
            // arguments, which the test harness would refuse as an unknown
            // option. After `--` they are two more test names, and with
            // `--exact` they name no test, so only the stand-in runs.
            json!([
                STAND_IN_TEST,
                "--exact",
                "--nocapture",
                "--test-threads",
                "1",
                "--"
            ]),
            json!({
                STAND_IN: role,
                STAND_IN_CONNECTION: connection_file,
                STAND_IN_SHARED: world.shared,
            }),
        )
    };
    let mut module_env = serde_json::Map::new();
    if moves {
        module_env.insert(mc_module::agent_data::ENV.to_owned(), "1".into());
    }
    let module_env = Value::Object(module_env);
    std::fs::write(
        dir.join("config/cortexkit/subc.jsonc"),
        json!({
            "version": 1,
            "modules": {
                PROVIDER: entry(&module, subc_args.clone(), module_env),
                RUNNER: entry(&runner, subc_args, json!({
                    "MOCK_RUNNER_PROVIDER": PROVIDER,
                    "MC_MOCK_OBSERVE": "0",
                })),
                "entorhinal": stand_in_entry("entorhinal"),
                "engram": stand_in_entry("engram"),
            },
        })
        .to_string(),
    )
    .unwrap();
    let processes = vec![spawn(
        &daemon,
        &[],
        dir,
        &dir.join("data"),
        &[("SUBC_PORT", "0"), ("SUBC_CGROUP_PLACEMENT", "disabled")],
        label,
    )];
    let deadline = Instant::now() + START_TIMEOUT;
    while !connection_file.exists() {
        assert!(
            Instant::now() < deadline,
            "the daemon wrote no connection file"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let machine = Machine {
        connection_file,
        context_db: context_db_of(dir),
        _processes: processes,
    };
    machine
        .ready(&[PROVIDER, RUNNER, "entorhinal", "engram"])
        .await;
    machine
}

/// What the stand-in Entorhinal got back for one agent-data request.
#[derive(Debug)]
enum Driven {
    /// ck-mc's reply, as the bytes it sent.
    Reply(String),
    /// ck-mc's refusal, as its error frame carried it.
    Refused(Value),
    /// The call failed before ck-mc answered it, as when the daemon has
    /// no agent-data route to open.
    Failed(String),
}

impl Driven {
    #[track_caller]
    fn refusal(self) -> Value {
        match self {
            Self::Refused(body) => body,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }
}

impl Machine {
    async fn consumer(&self) -> SubcConsumer {
        SubcConsumer::connect(&self.connection_file, ConsumerOptions::default())
            .await
            .unwrap()
    }

    /// Wait until the daemon lists every one of `modules` as ready.
    async fn ready(&self, modules: &[&str]) {
        let consumer = self.consumer().await;
        let deadline = Instant::now() + START_TIMEOUT;
        loop {
            let catalog = consumer.catalog_list().await;
            let listed = catalog.as_ref().map(|catalog| {
                modules.iter().all(|module| {
                    catalog
                        .modules
                        .iter()
                        .any(|entry| entry.module_id == *module && entry.ready)
                })
            });
            if listed.as_ref().is_ok_and(|ready| *ready) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "the modules never all became ready: {:?}",
                catalog.map(|catalog| catalog
                    .modules
                    .into_iter()
                    .map(|entry| (entry.module_id, entry.ready, entry.not_ready))
                    .collect::<Vec<_>>())
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// The claims ck-mc declares in the daemon's catalog.
    async fn claims(&self) -> Vec<String> {
        let catalog = self.consumer().await.catalog_list().await.unwrap();
        catalog
            .modules
            .into_iter()
            .find(|entry| entry.module_id == PROVIDER)
            .and_then(|entry| entry.capabilities)
            .map(|capabilities| capabilities.provides)
            .unwrap_or_default()
    }

    /// One call to `module`'s management surface.
    async fn manage(
        &self,
        module: &str,
        method: &str,
        params: &Value,
    ) -> Result<Value, subc_client_rs::CallError> {
        let reply = self
            .consumer()
            .await
            .call(
                RouteTarget::ManagementSurface {
                    module_id: module.into(),
                },
                BindIdentity::new("wire", "agent-data-test"),
                wire::encode(method, params),
                CallOptions {
                    timeout: Duration::from_secs(300),
                    ..CallOptions::default()
                },
            )
            .await?;
        Ok(serde_json::from_slice(&reply).unwrap())
    }

    /// Have the stand-in Entorhinal send `agent_data.<op>` to ck-mc.
    async fn drive(&self, op: &str, params: Value) -> Driven {
        let request = json!({"method": format!("agent_data.{op}"), "params": params});
        let answer = self
            .manage("entorhinal", DRIVE, &request)
            .await
            .unwrap_or_else(|error| panic!("the stand-in Entorhinal failed: {error:?}"));
        let result = &answer["result"];
        if let Some(text) = result["reply"].as_str() {
            Driven::Reply(text.to_owned())
        } else if let Some(body) = result.get("refused") {
            Driven::Refused(body.clone())
        } else {
            Driven::Failed(result["failed"].as_str().unwrap_or_default().to_owned())
        }
    }

    async fn op(&self, op: &str, cut: &str, sessions: &[&str]) -> Driven {
        self.drive(op, json!({"refs": refs(sessions), "cutId": cut}))
            .await
    }

    async fn release(&self, cut: &str, sessions: &[&str], holder: &str) -> Driven {
        self.drive(
            "release",
            json!({"refs": refs(sessions), "cutId": cut, "holder": holder}),
        )
        .await
    }

    /// An app read of a session's meta section, over ck-mc's management
    /// surface: its answer, or the refusal's code and detail.
    async fn app_read(&self, session: &str) -> Result<Value, (String, Option<Value>)> {
        self.manage(
            PROVIDER,
            "session_data.read",
            &json!({
                "session": {"runner": RUNNER, "harness": HARNESS, "session": session},
                "section": "meta",
            }),
        )
        .await
        .map_err(|error| match error {
            subc_client_rs::CallError::Module(body) => (body.code, body.detail),
            other => panic!("the app read failed in transport: {other:?}"),
        })
    }

    /// Play a short turn of a mock-runner session: its report, or the
    /// message of the refusal that stopped it.
    async fn play(&self, session: &str) -> Result<Report, String> {
        let mut config = super::config("worker");
        config.session = SessionRef::new(RUNNER, HARNESS, session);
        let request = PlayRequest {
            config,
            steps: vec![
                answer(),
                Step::Await {
                    condition: mc_mock_runner::script::AwaitCondition::NoticesProcessed,
                    timeout_ms: START_TIMEOUT.as_millis() as u64,
                },
            ],
        };
        match self
            .manage(RUNNER, MOCK_PLAY, &serde_json::to_value(&request).unwrap())
            .await
        {
            Ok(report) => Ok(serde_json::from_value(report).unwrap()),
            Err(subc_client_rs::CallError::Module(body)) => Err(body.message),
            Err(other) => panic!("mock.play failed in transport: {other:?}"),
        }
    }

    fn conn(&self) -> Connection {
        open(&self.context_db)
    }

    fn journal(&self) -> PathBuf {
        mc_module::agent_data::journal::path(&self.context_db)
    }
}

fn refs(sessions: &[&str]) -> Value {
    Value::Array(
        sessions
            .iter()
            .map(|session| json!({"ref_kind": KIND, "ref": session}))
            .collect(),
    )
}

/// The moved session's committed publication, which holds waiting facts.
const PUBLICATION: &str = "wire-pub";

fn compartment(conn: &Connection, session: &str, sequence: i64) -> i64 {
    conn.execute(
        "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id,
            title, content, p1, importance, created_at, harness)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'p1', 60, 100, ?9)",
        params![
            session,
            sequence,
            sequence * 10,
            sequence * 10 + 9,
            format!("m-{}", sequence * 10),
            format!("m-{}", sequence * 10 + 9),
            format!("summary {sequence}"),
            format!("what happened in part {sequence}"),
            HARNESS
        ],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// A publication of `session` with its first turn's stage row, committed
/// after every other publication on this machine when `committed`.
fn publication(conn: &Connection, id: &str, session: &str, committed: bool, state: &str) {
    conn.execute(
        "INSERT INTO memory_publications(publication_id, project_path, source_session_id, commit_order, committed_at)
         VALUES (?1, ?2, ?3,
            CASE WHEN ?4 THEN (SELECT COALESCE(MAX(commit_order), 0) + 1 FROM memory_publications) END,
            CASE WHEN ?4 THEN 10 END)",
        params![id, PROJECT, session, committed],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_stage_attempts(stage_key, project_path, publication_id, run_attempt, stage,
            session_id, harness, carrier, state, request_json, started_at)
         VALUES (?1, ?2, ?3, 1, 'turn_one', ?4, ?5, 'ck-mc', ?6, '{}', 1)",
        params![
            json!([PROJECT, id, 1, "turn_one"]).to_string(),
            PROJECT,
            id,
            session,
            HARNESS,
            state
        ],
    )
    .unwrap();
}

fn fact(
    conn: &Connection,
    publication: &str,
    index: i64,
    compartment: Option<i64>,
    state: &str,
) -> i64 {
    conn.execute(
        "INSERT INTO memory_pending_facts(project_path, publication_id, fact_index, compartment_id, category,
            content, anchor_known, state, fact_attempts, reason, mapping_json, matched_memory_id)
         VALUES (?1, ?2, ?3, ?4, 'Decisions', ?5, 1, ?6, 1, 'why', '{}', 55)",
        params![
            PROJECT,
            publication,
            index,
            compartment,
            format!("fact {publication} {index}"),
            state
        ],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn block(conn: &Connection, publication: &str, session: &str, start: i64, end: i64) -> i64 {
    conn.execute(
        "INSERT INTO memory_fact_blocks(publication_id, source_session_id, start_ordinal, end_ordinal, role, parts_json, joined_text)
         VALUES (?1, ?2, ?3, ?4, 'user', '[\"text\"]', 'the words the fact came from')",
        params![publication, session, start, end],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn link(conn: &Connection, fact: i64, block: i64) {
    conn.execute(
        "INSERT INTO memory_fact_block_links(fact_id, block_id) VALUES (?1, ?2)",
        params![fact, block],
    )
    .unwrap();
}

/// The moved session's rows on the source: summaries with events, scores
/// and facts; a session note; its project link; one committed publication
/// holding two waiting facts (one whose summary was rewritten away) and an
/// applied, a covered and a decided-pending fact; and an uncommitted
/// publication. One of its score selections names a revision that no
/// longer exists.
fn seed_moved(conn: &Connection, session: &str) {
    let c1 = compartment(conn, session, 1);
    let c2 = compartment(conn, session, 2);
    let c3 = compartment(conn, session, 3);
    conn.execute_batch(&format!(
        "INSERT INTO compartment_events(session_id, compartment_id, kind, at_compartment, fields_json, created_at, harness) VALUES
            ('{session}', {c2}, 'causal_incident', 2, '{{\"a\":1}}', 1, '{HARNESS}'),
            ('{session}', NULL, 'trajectory_correction', 1, '{{}}', 2, '{HARNESS}');
         INSERT INTO compartment_score_revisions(compartment_id, session_id, source_identity, old_importance, new_importance,
            rubric_version, prompt_hash, model, seed_ids, job_id, batch_id, attempt_id, completed_at, reason) VALUES
            ({c1}, '{session}', 'src-a', 50, 70, 1, 'ph', 'm', '[]', 'job-1', 'batch-1', 'attempt-1', 5, 'clearer'),
            ({c2}, '{session}', 'src-a', 50, 40, 1, 'ph', 'm', '[]', 'job-1', 'batch-1', 'attempt-1', 5, 'minor');
         INSERT INTO session_facts(session_id, category, content, created_at, updated_at, harness) VALUES
            ('{session}', 'Decisions', 'a session fact', 1, 2, '{HARNESS}');
         INSERT INTO notes(type, status, content, session_id, project_path, created_at, updated_at, harness, anchor_ordinal) VALUES
            ('session', 'active', 'a session note', '{session}', '{PROJECT}', 1, 1, '{HARNESS}', 5);
         INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES
            ('{session}', '{HARNESS}', '{PROJECT}', 1);"
    ))
    .unwrap();
    let revision: i64 = conn
        .query_row(
            "SELECT id FROM compartment_score_revisions WHERE compartment_id = ?1",
            [c1],
            |row| row.get(0),
        )
        .unwrap();
    conn.execute_batch(&format!(
        "INSERT INTO compartment_score_selections(session_id, compartment_id, sequence, revision_id, origin, job_id, batch_id, attempt_id) VALUES
            ('{session}', {c1}, 1, {revision}, 'publication', 'job-1', 'batch-1', 'attempt-1'),
            ('{session}', {c2}, 2, NULL, 'undo', NULL, NULL, NULL),
            ('{session}', {c3}, 3, 777777, 'publication', 'job-2', 'batch-2', 'attempt-2');"
    ))
    .unwrap();
    publication(conn, PUBLICATION, session, true, "published");
    let b1 = block(conn, PUBLICATION, session, 1, 3);
    let b2 = block(conn, PUBLICATION, session, 4, 6);
    let waiting = fact(conn, PUBLICATION, 0, Some(c1), "retryable");
    let applied = fact(conn, PUBLICATION, 1, Some(c1), "applied");
    fact(conn, PUBLICATION, 2, None, "covered");
    let pending = fact(conn, PUBLICATION, 3, Some(c2), "decided_pending");
    let rewritten = fact(conn, PUBLICATION, 4, Some(999_999), "retryable");
    link(conn, waiting, b1);
    link(conn, applied, b1);
    link(conn, pending, b2);
    link(conn, rewritten, b2);
    publication(conn, "wire-pub-open", session, false, "sending");
    fact(conn, "wire-pub-open", 0, Some(c1), "retryable");
}

/// Another session's publications, committed on the destination before the
/// move. They hold the same commit-order values the moved publication has on
/// the source, so the import must queue the moved one after them and may not
/// keep its old value.
fn seed_destination(conn: &Connection) {
    for id in ["wire-b-1", "wire-b-2"] {
        publication(conn, id, "wire-b-own", true, "published");
        fact(conn, id, 0, None, "retryable");
    }
}

/// Every row a query returns, each as a JSON array of its columns.
fn rows(conn: &Connection, sql: &str, session: &str) -> Vec<Value> {
    let mut statement = conn.prepare(sql).unwrap();
    let columns = statement.column_count();
    statement
        .query_map(params![session, HARNESS], |row| {
            Ok(Value::Array(
                (0..columns)
                    .map(|index| match row.get_ref(index).unwrap() {
                        rusqlite::types::ValueRef::Null => Value::Null,
                        rusqlite::types::ValueRef::Integer(value) => json!(value),
                        rusqlite::types::ValueRef::Real(value) => json!(value),
                        rusqlite::types::ValueRef::Text(text) => {
                            json!(String::from_utf8_lossy(text))
                        }
                        rusqlite::types::ValueRef::Blob(blob) => json!(hex(blob)),
                    })
                    .collect(),
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// The session's moved rows as plain SQL reads them, every row id replaced
/// by the natural key of the row it names, and each fact in its logical
/// state: a fact a move reserved reads as the waiting fact it is. This is
/// independent of the snapshot encoder, so the comparison cannot share its
/// mistakes.
fn moved_rows(conn: &Connection, session: &str) -> BTreeMap<&'static str, Vec<Value>> {
    let queries: [(&str, &str); 12] = [
        (
            "compartments",
            "SELECT sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1,
                importance, created_at
             FROM compartments WHERE session_id = ?1 AND harness = ?2 ORDER BY sequence",
        ),
        (
            "compartment_events",
            "SELECT (SELECT c.sequence FROM compartments c WHERE c.id = e.compartment_id), kind, at_compartment,
                fields_json, created_at
             FROM compartment_events e WHERE session_id = ?1 AND harness = ?2 ORDER BY created_at",
        ),
        (
            "compartment_score_revisions",
            "SELECT c.sequence, r.source_identity, r.rubric_version, r.old_importance, r.new_importance,
                r.prompt_hash, r.model, r.seed_ids, r.job_id, r.batch_id, r.attempt_id, r.completed_at, r.reason
             FROM compartment_score_revisions r JOIN compartments c ON c.id = r.compartment_id
             WHERE c.session_id = ?1 AND c.harness = ?2 ORDER BY c.sequence",
        ),
        (
            "compartment_score_selections",
            "SELECT c.sequence, s.sequence,
                (SELECT json_array(rc.sequence, r.source_identity, r.rubric_version)
                 FROM compartment_score_revisions r JOIN compartments rc ON rc.id = r.compartment_id
                 WHERE r.id = s.revision_id),
                s.origin, s.job_id, s.batch_id, s.attempt_id
             FROM compartment_score_selections s JOIN compartments c ON c.id = s.compartment_id
             WHERE c.session_id = ?1 AND c.harness = ?2 ORDER BY c.sequence",
        ),
        (
            "session_facts",
            "SELECT category, content, created_at, updated_at FROM session_facts
             WHERE session_id = ?1 AND harness = ?2 ORDER BY content",
        ),
        (
            "notes",
            "SELECT type, status, content, project_path, created_at, updated_at, anchor_ordinal FROM notes
             WHERE session_id = ?1 AND harness = ?2 AND type = 'session' ORDER BY content",
        ),
        (
            "session_projects",
            "SELECT project_path FROM session_projects WHERE session_id = ?1 AND harness = ?2",
        ),
        (
            "memory_publications",
            "SELECT publication_id, project_path, source_session_id, committed_at FROM memory_publications
             WHERE source_session_id = ?1 AND commit_order IS NOT NULL AND ?2 = ?2 ORDER BY publication_id",
        ),
        (
            "memory_stage_attempts",
            "SELECT stage_key, project_path, publication_id, run_attempt, stage, carrier, state FROM memory_stage_attempts
             WHERE session_id = ?1 AND harness = ?2 AND stage = 'turn_one' AND state = 'published'
             ORDER BY stage_key",
        ),
        (
            "memory_fact_blocks",
            "SELECT b.publication_id, b.source_session_id, b.start_ordinal, b.end_ordinal, b.role, b.parts_json,
                b.joined_text
             FROM memory_fact_blocks b JOIN memory_publications p ON p.publication_id = b.publication_id
             WHERE p.source_session_id = ?1 AND p.commit_order IS NOT NULL AND ?2 = ?2
             ORDER BY b.publication_id, b.start_ordinal",
        ),
        (
            "memory_pending_facts",
            "SELECT f.publication_id, f.fact_index,
                (SELECT c.sequence FROM compartments c WHERE c.id = f.compartment_id AND c.session_id = ?1 AND c.harness = ?2),
                f.category, f.content, f.anchor_known, f.reason,
                CASE WHEN f.reserved_stage_key LIKE 'agent-data:%' THEN 'retryable' ELSE f.state END,
                CASE WHEN f.reserved_stage_key LIKE 'agent-data:%' THEN NULL ELSE f.reserved_stage_key END
             FROM memory_pending_facts f JOIN memory_publications p ON p.publication_id = f.publication_id
             WHERE p.source_session_id = ?1 AND p.commit_order IS NOT NULL
             ORDER BY f.publication_id, f.fact_index",
        ),
        (
            "memory_fact_block_links",
            "SELECT f.publication_id, f.fact_index, b.start_ordinal, b.end_ordinal
             FROM memory_fact_block_links l
             JOIN memory_pending_facts f ON f.id = l.fact_id
             JOIN memory_fact_blocks b ON b.id = l.block_id
             JOIN memory_publications p ON p.publication_id = f.publication_id
             WHERE p.source_session_id = ?1 AND p.commit_order IS NOT NULL AND ?2 = ?2
             ORDER BY 1, 2, 3",
        ),
    ];
    queries
        .into_iter()
        .map(|(table, sql)| (table, rows(conn, sql, session)))
        .collect()
}

/// Each fact of the moved publication as stored: its index, state,
/// reservation and whether it names no summary.
fn stored_facts(conn: &Connection) -> Vec<(i64, String, Option<String>, bool)> {
    conn.prepare(
        "SELECT fact_index, state, reserved_stage_key, compartment_id IS NULL FROM memory_pending_facts
         WHERE publication_id = ?1 ORDER BY fact_index",
    )
    .unwrap()
    .query_map([PUBLICATION], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

fn commit_order(conn: &Connection) -> Vec<String> {
    conn.prepare(
        "SELECT publication_id FROM memory_publications WHERE commit_order IS NOT NULL ORDER BY commit_order",
    )
    .unwrap()
    .query_map([], |row| row.get(0))
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

fn fingerprint(conn: &Connection, session: &str) -> mc_module::agent_data::snapshot::Fingerprint {
    mc_module::agent_data::snapshot::fingerprint(conn, HARNESS, session).unwrap()
}

/// A snapshot of `session` whose score selection, of a rescore's
/// publication, names no revision: a body no store can hold, since such a
/// selection must name its revision.
fn crafted_snapshot(dir: &Path, session: &str) -> Vec<u8> {
    use mc_module::agent_data::{moved::MOVED, snapshot};
    let path = dir.join("crafted.db");
    mc_module::context_db::ContextDb::create_for_tests(&path).unwrap();
    let mut conn = open(&path);
    let c1 = compartment(&conn, session, 1);
    conn.execute_batch(&format!(
        "INSERT INTO compartment_score_revisions(compartment_id, session_id, source_identity, old_importance, new_importance,
            rubric_version, prompt_hash, model, seed_ids, job_id, batch_id, attempt_id, completed_at, reason) VALUES
            ({c1}, '{session}', 'src-a', 50, 70, 1, 'ph', 'm', '[]', 'job-1', 'batch-1', 'attempt-1', 5, 'clearer');
         INSERT INTO compartment_score_selections(session_id, compartment_id, sequence, revision_id, origin, job_id, batch_id, attempt_id)
            SELECT '{session}', {c1}, 1, id, 'publication', 'job-1', 'batch-1', 'attempt-1' FROM compartment_score_revisions;"
    ))
    .unwrap();
    let key = SessionRef::new(RUNNER, HARNESS, session);
    let encoded = snapshot::read(&mut conn, &key).unwrap();
    let mut rows = snapshot::decode(&encoded.bytes).unwrap().rows;
    let selections = MOVED
        .iter()
        .position(|table| table.name == "compartment_score_selections")
        .unwrap();
    assert_eq!(rows.tables[selections].len(), 1);
    rows.tables[selections][0].insert("revision_id".into(), Value::Null);
    snapshot::encode(&key, encoded.header.schema_version, &rows).bytes
}

/// Decode a reply with the contract's type for it, and check ck-mc sent it
/// in the contract's canonical form.
#[track_caller]
fn contract_reply<T: serde::de::DeserializeOwned + serde::Serialize>(driven: Driven) -> Value {
    let Driven::Reply(text) = driven else {
        panic!("expected a reply, got {driven:?}");
    };
    let decoded: T = serde_json::from_str(&text).unwrap();
    assert_eq!(serde_jcs::to_string(&decoded).unwrap(), text);
    serde_json::from_str(&text).unwrap()
}

/// A refusal's code, after checking its body decodes as the contract's
/// error body with a detail of the type its code names.
#[track_caller]
fn contract_refusal(driven: Driven) -> (String, Value) {
    let body = driven.refusal();
    let decoded: contract::errors::ErrorBody = serde_json::from_value(body.clone()).unwrap();
    decoded.typed_detail().unwrap();
    (decoded.code.as_str().to_owned(), body)
}

const CUT: &str = "0123456789abcdef0123456789abcdef";
const BACK: &str = "fedcba9876543210fedcba9876543210";
const CRAFTED: &str = "00112233445566778899aabbccddeeff";
/// The session with rows in every moved table.
const MOVED: &str = "wire-moved";
/// A session with no `context.db` rows at all.
const EMPTY: &str = "wire-empty";
/// A session whose only snapshot is one no store can hold.
const BROKEN: &str = "wire-crafted";

fn session_ref(session: &str) -> String {
    mc_module::agent_data::source::session_ref(&SessionRef::new(RUNNER, HARNESS, session))
}

/// The item of an `import` or `prepare` reply for `session`.
fn item<'a>(reply: &'a Value, session: &str) -> &'a Value {
    let wanted = session_ref(session);
    reply["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["sessionRef"] == wanted.as_str())
        .unwrap_or_else(|| panic!("no item for {session} in {reply}"))
}

fn states(diverged: &Value) -> Vec<&str> {
    diverged["refs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["state"].as_str().unwrap())
        .collect()
}

/// That a session is not refused by a move: an app read of it answers, or
/// is refused for another reason than a move.
#[track_caller]
fn not_gated(read: Result<Value, (String, Option<Value>)>) {
    if let Err((code, detail)) = read {
        assert!(
            code != "session_moving" && code != "session_moved",
            "{code} {detail:?}"
        );
    }
}

/// With moves off, ck-mc declares no agent-data service and claims no
/// `agent-data/v1`, so the daemon has no route for Entorhinal to open and
/// nothing of a move is read or written.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs the daemon and mock runner binaries; run through scripts/wire-gate.sh"]
async fn with_moves_off_ck_mc_declares_no_agent_data_service_and_serves_no_request() {
    let started = Instant::now();
    let world = World::new();
    world.bind(&[MOVED]);
    let dir = prepare_machine(&world, "off");
    seed_moved(&open(&context_db_of(&dir)), MOVED);
    let machine = start_machine(&world, &dir, "subc-off", false).await;

    let claims = machine.claims().await;
    assert!(
        claims.contains(&cortexkit_role_compaction::COMPACTION_PROVIDES.to_owned()),
        "{claims:?}"
    );
    assert!(
        !claims.contains(&contract::PROVIDES.to_owned()),
        "{claims:?}"
    );
    for (op, params) in [
        ("describe", json!({})),
        ("prepare", json!({"refs": refs(&[MOVED]), "cutId": CUT})),
    ] {
        // The daemon refuses to open the route, as to any service a module
        // does not declare, so the request never reaches ck-mc.
        match machine.drive(op, params).await {
            Driven::Failed(error) => assert!(error.contains("target_unavailable"), "{error}"),
            other => panic!("{op} with moves off got {other:?}"),
        }
    }
    assert!(!machine.journal().exists());
    let facts = stored_facts(&machine.conn());
    assert!(facts.iter().all(|(_, _, reserved, _)| reserved.is_none()));
    eprintln!(
        "wire time: with_moves_off_ck_mc_declares_no_agent_data_service_and_serves_no_request took {:.1}s",
        started.elapsed().as_secs_f64()
    );
}

/// A full move between two machines over the real wire, then a move back.
/// The session with rows in every moved table reads the same on the
/// destination, ignoring row ids: its summaries with their scores and
/// facts, its session note, its project link, and its committed
/// publication with every fact in its logical state, queued after the
/// destination's own publications. A session with no rows arrives with
/// none. While staged, the destination refuses the session
/// `session_moving`; once released, the source refuses it `session_moved`
/// naming the new holder; other sessions are served on both throughout.
/// A body no store can hold is refused at import, and nothing is staged.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs the daemon and mock runner binaries; run through scripts/wire-gate.sh"]
async fn a_session_moves_to_another_machine_and_back_over_the_real_wire() {
    let started = Instant::now();
    let world = World::new();
    world.bind(&[MOVED, EMPTY, BROKEN]);
    let a_dir = prepare_machine(&world, "a");
    let b_dir = prepare_machine(&world, "b");
    seed_moved(&open(&context_db_of(&a_dir)), MOVED);
    seed_destination(&open(&context_db_of(&b_dir)));
    let (a, b) = tokio::join!(
        start_machine(&world, &a_dir, "subc-a", true),
        start_machine(&world, &b_dir, "subc-b", true)
    );
    for machine in [&a, &b] {
        assert!(machine
            .claims()
            .await
            .contains(&contract::PROVIDES.to_owned()));
    }
    let source_rows = moved_rows(&a.conn(), MOVED);
    let source_fingerprint = fingerprint(&a.conn(), MOVED);
    assert_eq!(commit_order(&a.conn()), [PUBLICATION]);
    assert_eq!(commit_order(&b.conn()), ["wire-b-1", "wire-b-2"]);
    let sessions = [MOVED, EMPTY];

    // Out: the source freezes and cuts both sessions, and exports them.
    let prepared =
        contract_reply::<contract::prepare::PrepareReply>(a.op("prepare", CUT, &sessions).await);
    for session in sessions {
        assert_eq!(item(&prepared, session)["frozen"], true);
        assert_eq!(item(&prepared, session)["stream"], "reserved:magic-context");
    }
    world.seal(CUT, &prepared);
    contract_reply::<contract::export::ExportReply>(a.op("export", CUT, &sessions).await);

    // In: nothing of the destination's own is in the way, and it stages
    // both. The rows left out on purpose are counted.
    let diverged =
        contract_reply::<contract::diverged::DivergedReply>(b.op("diverged", CUT, &sessions).await);
    assert_eq!(states(&diverged), ["at_cut", "at_cut"]);
    let Driven::Reply(import_text) = b.op("import", CUT, &sessions).await else {
        panic!("import was refused");
    };
    let imported =
        contract_reply::<contract::import::ImportReply>(Driven::Reply(import_text.clone()));
    assert_eq!(
        item(&imported, MOVED)["dropped"],
        json!({"dangling_reference": 1, "uncommitted_publication": 1})
    );
    assert_eq!(item(&imported, EMPTY).get("dropped"), None);
    for member in ["endOffset", "digest"] {
        assert_eq!(
            item(&imported, MOVED)[member],
            item(&prepared, MOVED)[member]
        );
    }
    // A repeat is answered with the first reply's bytes.
    match b.op("import", CUT, &sessions).await {
        Driven::Reply(again) => assert_eq!(again, import_text),
        other => panic!("the repeated import got {other:?}"),
    }

    // Staged on the destination: the session's Setup and app reads are
    // refused, and another session there is served.
    let refused = b.play(MOVED).await.unwrap_err();
    assert!(
        refused.contains(&format!("is staged by agent-data cut {CUT}")),
        "{refused}"
    );
    assert_eq!(
        b.app_read(MOVED).await.unwrap_err(),
        ("session_moving".to_owned(), Some(json!({"cut": CUT})))
    );
    let report = b.play("wire-b-other").await.unwrap();
    assert!(report.call_errors.is_empty(), "{:?}", report.call_errors);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);

    // Released: the source refuses the session, naming the new holder,
    // and serves another session as before.
    let released = contract_reply::<contract::release::ReleaseReply>(
        a.release(CUT, &sessions, "machine-b").await,
    );
    assert_eq!(released, json!({"enforced": true}));
    assert_eq!(
        a.app_read(MOVED).await.unwrap_err(),
        (
            "session_moved".to_owned(),
            Some(json!({"holder": "machine-b"}))
        )
    );
    let refused = a.play(MOVED).await.unwrap_err();
    assert!(refused.contains("was moved to machine-b"), "{refused}");
    let report = a.play("wire-a-other").await.unwrap();
    assert!(report.call_errors.is_empty(), "{:?}", report.call_errors);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);

    // Activated: the destination holds the session as the source did,
    // ignoring row ids. The selection naming a missing revision and the
    // uncommitted publication stayed behind.
    assert_eq!(
        contract_reply::<contract::EmptyReply>(b.op("activate", CUT, &sessions).await),
        json!({})
    );
    let mut expected = source_rows.clone();
    expected
        .get_mut("compartment_score_selections")
        .unwrap()
        .retain(|row| row[0] != json!(3));
    assert_eq!(expected["compartment_score_selections"].len(), 2);
    assert_eq!(moved_rows(&b.conn(), MOVED), expected);
    assert_eq!(fingerprint(&b.conn(), MOVED), source_fingerprint);
    let fact = |index: i64, state: &str, reserved: Option<&str>, no_summary: bool| {
        (
            index,
            state.to_owned(),
            reserved.map(str::to_owned),
            no_summary,
        )
    };
    assert_eq!(
        stored_facts(&b.conn()),
        [
            fact(0, "retryable", None, false),
            fact(1, "applied", None, false),
            fact(2, "covered", None, true),
            fact(3, "decided_pending", None, false),
            fact(4, "retryable", None, true),
        ]
    );
    assert_eq!(
        commit_order(&b.conn()),
        ["wire-b-1", "wire-b-2", PUBLICATION]
    );
    assert_eq!(fingerprint(&b.conn(), EMPTY).rows, 0);
    assert!(moved_rows(&b.conn(), EMPTY)
        .values()
        .all(|rows| rows.is_empty()));
    not_gated(b.app_read(MOVED).await);
    // The source keeps its hidden copy, the waiting facts reserved by the
    // move so this machine never decides them again.
    let reserved = format!("agent-data:{CUT}");
    assert_eq!(
        stored_facts(&a.conn()),
        [
            fact(0, "in_flight", Some(&reserved), false),
            fact(1, "applied", None, false),
            fact(2, "covered", None, true),
            fact(3, "decided_pending", None, false),
            fact(4, "in_flight", Some(&reserved), false),
        ]
    );

    // A body carrying a score selection of a rescore's publication with no
    // revision is refused at import, and nothing of it is staged.
    let crafted = crafted_snapshot(&world.root.0, BROKEN);
    std::fs::write(stream_path(&world.shared, &session_ref(BROKEN)), &crafted).unwrap();
    world.seal(
        CRAFTED,
        &json!({"items": [{
            "sessionRef": session_ref(BROKEN),
            "endOffset": crafted.len(),
            "digest": sha256(&crafted),
        }]}),
    );
    let (code, body) = contract_refusal(b.op("import", CRAFTED, &[BROKEN]).await);
    assert_eq!(code, "incompatible_version", "{body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("compartment_score_selections"),
        "{body}"
    );
    let journal = std::fs::read_to_string(b.journal()).unwrap();
    assert!(!journal.contains(BROKEN), "{journal}");
    assert!(!mc_module::agent_data::source::cut_folder(&b.context_db, CRAFTED).exists());
    not_gated(b.app_read(BROKEN).await);

    // Back: the destination cuts the sessions again, and the source, which
    // still holds what it released, finds its rows at the cut and takes
    // them back, replacing its hidden copy.
    let prepared =
        contract_reply::<contract::prepare::PrepareReply>(b.op("prepare", BACK, &sessions).await);
    world.seal(BACK, &prepared);
    contract_reply::<contract::export::ExportReply>(b.op("export", BACK, &sessions).await);
    let diverged = contract_reply::<contract::diverged::DivergedReply>(
        a.op("diverged", BACK, &sessions).await,
    );
    assert_eq!(states(&diverged), ["at_cut", "at_cut"]);
    contract_reply::<contract::import::ImportReply>(a.op("import", BACK, &sessions).await);
    contract_reply::<contract::release::ReleaseReply>(
        b.release(BACK, &sessions, "machine-a").await,
    );
    contract_reply::<contract::EmptyReply>(a.op("activate", BACK, &sessions).await);
    assert_eq!(moved_rows(&a.conn(), MOVED), moved_rows(&b.conn(), MOVED));
    assert_eq!(moved_rows(&a.conn(), MOVED), expected);
    assert_eq!(fingerprint(&a.conn(), MOVED), fingerprint(&b.conn(), MOVED));
    assert_eq!(
        stored_facts(&a.conn()),
        [
            fact(0, "retryable", None, false),
            fact(1, "applied", None, false),
            fact(2, "covered", None, true),
            fact(3, "decided_pending", None, false),
            fact(4, "retryable", None, true),
        ]
    );
    assert_eq!(fingerprint(&a.conn(), EMPTY).rows, 0);
    not_gated(a.app_read(MOVED).await);
    assert_eq!(
        b.app_read(MOVED).await.unwrap_err(),
        (
            "session_moved".to_owned(),
            Some(json!({"holder": "machine-a"}))
        )
    );
    eprintln!(
        "wire time: a_session_moves_to_another_machine_and_back_over_the_real_wire took {:.1}s",
        started.elapsed().as_secs_f64()
    );
}
