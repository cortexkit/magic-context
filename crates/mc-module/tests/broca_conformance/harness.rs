use super::*;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use subc_client_rs::{
    async_trait, BindDecision, CallError, CallOptions, ConsumerOptions, HandlerOutcome,
    ModuleHandler, RequestCtx, RouteBindRequest, SubcConsumer,
};
use subc_daemon::{serve_listener, ConnectedClients, ControlHandler, Registry, Router, ServerAuth};
use subc_protocol::manifest::{
    Concurrency, ManagementOperation, ManagementOperationKind, ModuleManifest, ProviderRole,
};
use subc_protocol::{BindIdentity, RouteTarget, PROTOCOL_VERSION};
use subc_transport::{
    generate_daemon_id, generate_key, write_atomic, ConnectionInfo, Endpoint, SCHEMA_VERSION,
};
use tokio::{net::TcpListener, task::JoinHandle};

pub const PROJECT: &str = "/joint/project";
pub const SESSION: &str = "alfonso:joint";
pub const LINEAGE: &str = "joint-lineage";
const TIMEOUT: Duration = Duration::from_secs(30);

pub struct Process(pub Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[derive(Clone, Debug)]
pub struct Callback {
    pub identity: BindIdentity,
    pub request: Value,
}

#[derive(Default)]
pub struct Script {
    pub messages: Mutex<Vec<Value>>,
    pub calls: Mutex<Vec<Callback>>,
    routes: Mutex<HashMap<u16, BindIdentity>>,
    pub page_size: Mutex<usize>,
}

impl Script {
    pub fn transcript(&self, messages: Vec<Value>) {
        *self.messages.lock().unwrap() = messages;
    }

    pub fn callbacks(&self) -> Vec<Callback> {
        self.calls.lock().unwrap().clone()
    }
}

struct Runner(Arc<Script>);
#[async_trait]
impl ModuleHandler for Runner {
    async fn on_bind(&self, req: &RouteBindRequest) -> BindDecision {
        self.0
            .routes
            .lock()
            .unwrap()
            .insert(req.handle.channel, req.identity.clone());
        BindDecision::accept()
    }

    async fn handle(&self, ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome {
        let request: Value = serde_json::from_slice(&body).unwrap();
        let identity = self.0.routes.lock().unwrap()[&ctx.route_handle().channel].clone();
        self.0.calls.lock().unwrap().push(Callback {
            identity,
            request: request.clone(),
        });
        let answer = match request["method"].as_str().unwrap() {
            "compaction.ready" => json!({}),
            "session.head" => {
                let messages = self.0.messages.lock().unwrap();
                json!({"lineage_id":LINEAGE,"head":messages.last().map(|m| json!({"ordinal":m["ordinal"],"mid":m["mid"]}))})
            }
            "session.read" => {
                let all = self.0.messages.lock().unwrap();
                let from = request["params"]["from_ordinal"].as_u64().unwrap_or(0);
                let cap = request["params"]["max_bytes"]
                    .as_u64()
                    .unwrap_or(4 * 1024 * 1024)
                    .min(16 * 1024 * 1024) as usize;
                let page_size = *self.0.page_size.lock().unwrap();
                let mut messages = Vec::new();
                let mut bytes = 0;
                for message in all
                    .iter()
                    .filter(|m| m["ordinal"].as_u64().unwrap() >= from)
                {
                    let size = serde_json::to_vec(message).unwrap().len();
                    if !messages.is_empty()
                        && (bytes + size > cap || (page_size > 0 && messages.len() >= page_size))
                    {
                        break;
                    }
                    messages.push(message.clone());
                    bytes += size;
                }
                let next = messages
                    .last()
                    .and_then(|m| m["ordinal"].as_u64())
                    .map(|n| n + 1);
                let mut page = json!({"lineage_id":LINEAGE,"messages":messages,
                    "head":all.last().map(|m| json!({"ordinal":m["ordinal"],"mid":m["mid"]}))});
                if next.is_some_and(|n| {
                    all.last()
                        .is_some_and(|m| n <= m["ordinal"].as_u64().unwrap())
                }) {
                    page["next_from_ordinal"] = json!(next.unwrap());
                }
                page
            }
            method => {
                return HandlerOutcome::Error {
                    code: "unexpected_script_call".into(),
                    message: method.into(),
                }
            }
        };
        HandlerOutcome::Response(serde_json::to_vec(&answer).unwrap())
    }
}

pub struct Rig {
    pub dir: tempfile::TempDir,
    pub connection: PathBuf,
    pub consumer: SubcConsumer,
    pub script: Arc<Script>,
    pub module: Option<Process>,
    daemon: JoinHandle<()>,
    runner: JoinHandle<()>,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.module.take();
        self.runner.abort();
        self.daemon.abort();
    }
}

impl Rig {
    pub async fn start(fault: Option<&str>, disabled: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        mc_store::private_permissions::tighten_directory(dir.path(), true);
        for path in [
            "config/cortexkit",
            "data/cortexkit/magic-context",
            "runtime",
            "project",
            "another-project",
        ] {
            mc_store::private_permissions::ensure_directory(&dir.path().join(path), true).unwrap();
        }
        mc_store::single_store_domain::create_test_context_db(
            &dir.path().join("data/cortexkit/magic-context/context.db"),
        )
        .unwrap();
        fs::write(
            dir.path().join("config/cortexkit/magic-context.jsonc"),
            serde_json::to_vec(&json!({
                "compaction":{"enabled": !disabled},
                "execute_threshold_percentage":65,
                "protected_tokens":4000,
                "historian":{"runner":"host","protected_tokens":0},
                "dreamer":{"runner":"host","inject_docs":false},
                "protected_tools":[]
            }))
            .unwrap(),
        )
        .unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let connection = dir.path().join("runtime/subc-connection.json");
        let info = ConnectionInfo {
            schema: SCHEMA_VERSION,
            wire_version: Some(PROTOCOL_VERSION),
            endpoints: vec![Endpoint {
                host: "127.0.0.1".into(),
                port: listener.local_addr().unwrap().port(),
            }],
            key: generate_key().unwrap(),
            daemon_id: generate_daemon_id().unwrap(),
            pid: std::process::id(),
            daemon_ver: "broca-conformance-v1".into(),
        };
        write_atomic(&connection, &info).unwrap();
        let connected = ConnectedClients::new();
        let control = Arc::new(
            ControlHandler::new(Arc::new(Registry::default()))
                .with_storage_config(Some(subc_daemon::daemon_config::StorageConfig::Sqlite {
                    data_home: dir.path().join("data"),
                }))
                .with_connected_clients(connected.clone()),
        );
        let router = Arc::new(Router::with_control_handler(control));
        let auth = ServerAuth::new(info.key, info.daemon_id, info.daemon_ver)
            .with_connected_clients(connected);
        let daemon = tokio::spawn(async move {
            serve_listener(listener, router, auth).await.unwrap();
        });
        let script = Arc::new(Script::default());
        let manifest = ModuleManifest::builder("broca", "0.0.0")
            .provides(vec![ProviderRole::ManagementSurface {
                operations: ["session.read", "session.head", "compaction.ready"]
                    .into_iter()
                    .map(|name| ManagementOperation {
                        name: name.into(),
                        kind: ManagementOperationKind::Query,
                        description: None,
                    })
                    .collect(),
                config_schema: json!({}),
                observability: vec![],
                identity_scope: vec![],
                concurrency: Concurrency::ModuleManaged,
            }])
            .build();
        let (_, serving) =
            subc_client_rs::serve_with_handle(&connection, manifest, Runner(script.clone()))
                .await
                .unwrap();
        let runner = tokio::spawn(async move {
            serving.await.unwrap();
        });
        let consumer = SubcConsumer::connect(&connection, ConsumerOptions::default())
            .await
            .unwrap();
        let mut rig = Self {
            dir,
            connection,
            consumer,
            script,
            module: None,
            daemon,
            runner,
        };
        rig.spawn(fault);
        rig.wait_ready().await;
        rig
    }

    pub fn spawn(&mut self, fault: Option<&str>) {
        if fault.is_some() {
            let binary = fs::read(env!("CARGO_BIN_EXE_ck-mc")).unwrap();
            assert!(binary.windows(b"MC_PROVIDER_FAULT_REACHED".len()).any(|bytes| bytes == b"MC_PROVIDER_FAULT_REACHED"),
                "the kill test requires ck-mc built with drive-fault, not a concurrent deploy build");
        }
        let stderr = fs::File::create(self.dir.path().join("module.stderr")).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_ck-mc"));
        command
            .args(["--subc"])
            .arg(&self.connection)
            .current_dir(self.dir.path())
            .env("HOME", self.dir.path().join("config"))
            .env("XDG_CONFIG_HOME", self.dir.path().join("config"))
            .env("XDG_DATA_HOME", self.dir.path().join("data"))
            .env("XDG_RUNTIME_DIR", self.dir.path().join("runtime"))
            .env_remove("MAGIC_CONTEXT_TEST_DATA_DIR")
            .env_remove("MAGIC_CONTEXT_STORAGE_DIR")
            .env_remove(subc_protocol::SUBC_MODULE_ID_ENV)
            .env_remove(subc_protocol::SUBC_LAUNCH_NONCE_ENV)
            .env_remove(subc_os::LAUNCH_NONCE_FD_ENV)
            .env_remove("MC_DRIVE_FAULT")
            .env_remove("MC_PROVIDER_FAULT_POINT")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr);
        if let Some(point) = fault {
            command.env("MC_PROVIDER_FAULT_POINT", point);
        }
        self.module = Some(Process(command.spawn().unwrap()));
    }

    pub async fn wait_ready(&self) {
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        loop {
            let catalog = self.consumer.catalog_list().await.unwrap();
            if catalog
                .modules
                .iter()
                .any(|m| m.module_id == "magic-context" && m.ready)
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "ck-mc startup: {}",
                self.stderr()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        loop {
            let result = self
                .try_call(
                    &self.identity("readiness"),
                    json!({"kind":"health","session_id":"readiness"}),
                )
                .await;
            if result.as_ref().is_ok_and(|v| v["store_open"] == true) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "store startup: {result:?}: {}",
                self.stderr()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    pub fn stderr(&self) -> String {
        fs::read_to_string(self.dir.path().join("module.stderr")).unwrap()
    }

    pub async fn wait_fault(&self, point: &str) {
        let marker = format!("MC_PROVIDER_FAULT_REACHED {point}");
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        while !self.stderr().contains(&marker) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "fault marker absent: {}",
                self.stderr()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    pub fn identity(&self, session: &str) -> BindIdentity {
        BindIdentity::new(self.dir.path().join("project"), "runner", session)
    }

    pub async fn try_call(
        &self,
        identity: &BindIdentity,
        request: Value,
    ) -> Result<Value, CallError> {
        let bytes = self
            .consumer
            .call(
                RouteTarget::ToolProvider {
                    module_id: "magic-context".into(),
                },
                identity.clone(),
                serde_json::to_vec(&request).unwrap(),
                options(),
            )
            .await?;
        Ok(serde_json::from_slice(&bytes).unwrap())
    }

    pub async fn call(&self, identity: &BindIdentity, request: Value) -> Value {
        self.try_call(identity, request.clone())
            .await
            .unwrap_or_else(|e| panic!("{request}: {e:?}\n{}", self.stderr()))
    }

    pub async fn method(&self, identity: &BindIdentity, method: &str, params: Value) -> Value {
        self.call(identity, json!({"method":method,"params":params}))
            .await
    }

    pub fn store(&self) -> mc_store::McStore {
        mc_store::McStore::open(&mc_module::dev_descriptor_at(
            self.dir.path().join("data").to_str().unwrap(),
        ))
        .unwrap()
    }

    pub fn record(&self, session: &str) -> Value {
        let key = mc_store::provider_records::ProviderSessionKey {
            project_root: self.dir.path().join("project").to_str().unwrap().into(),
            session: session.into(),
            harness: "broca".into(),
        };
        serde_json::from_str(&self.store().load_provider_record(&key).unwrap().unwrap()).unwrap()
    }

    pub fn engine_key(&self, session: &str) -> String {
        let key =
            json!({"project":self.dir.path().join("project"),"session":session,"harness":"broca"});
        // MC hashes its records::Key struct as project, session, harness in that
        // order. JSON map key sorting would produce a different session hash.
        let key = format!(
            "{{\"project\":{},\"session\":{},\"harness\":{}}}",
            key["project"], key["session"], key["harness"]
        );
        format!("mc-provider:{:x}", Sha256::digest(key.as_bytes()))
    }

    pub fn publish_history(&self, session: &str) {
        let mut host = mc_module::host_store::HostStore::open(
            &self
                .dir
                .path()
                .join("data/cortexkit/magic-context/context.db"),
        )
        .unwrap();
        host.with_domain_transaction(&["compartments"], &mut |tx| {
            tx.execute("INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,start_block_index,end_block_index,title,content,p1,importance,legacy,created_at,harness) VALUES (?1,1,0,0,'m0','m0',0,0,'history','JOINT HISTORY','JOINT HISTORY',50,0,1,'broca')", [self.engine_key(session)])?;
            Ok(())
        }).unwrap();
    }

    pub fn publish_more_history(&self, session: &str) {
        let mut host = mc_module::host_store::HostStore::open(
            &self
                .dir
                .path()
                .join("data/cortexkit/magic-context/context.db"),
        )
        .unwrap();
        host.with_domain_transaction(&["compartments"], &mut |tx| {
            tx.execute("INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,start_block_index,end_block_index,title,content,p1,importance,legacy,created_at,harness) VALUES (?1,2,1,1,'m1','m1',0,0,'second history','SECOND HISTORY','SECOND HISTORY',50,0,2,'broca')", [self.engine_key(session)])?;
            Ok(())
        }).unwrap();
    }
}

pub fn options() -> CallOptions {
    CallOptions {
        timeout: TIMEOUT,
        route_retry_deadline: Duration::from_secs(5),
        ..CallOptions::default()
    }
}

pub fn setup(session: &str) -> Value {
    json!({"session":session,"harness":"broca","request_id":"setup","preset":"head","params":{},"composition":{},"model":"fixture","context_window":100_000,"now":1,"lineage_id":LINEAGE})
}

pub fn message(ordinal: u64, role: &str, content: Value) -> Value {
    json!({"ordinal":ordinal,"mid":format!("m{ordinal}"),"message":{"role":role,"content":content}})
}

pub fn user(ordinal: u64, text: &str) -> Value {
    message(ordinal, "user", json!([{"type":"text","text":text}]))
}

pub fn step(session: &str, id: &str, messages: &[Value], tokens: u64, last: &Value) -> Value {
    let mut request = json!({"session":session,"harness":"broca","request_id":id,"lineage_id":LINEAGE,"step_id":id,"step_kind":"user_turn","model":"fixture","context_window":100_000,"estimate":{"request_tokens":tokens},"messages":messages,"now":2,
        "last_applied":{"compaction_id":last["compaction_id"],"version":last["version"]}});
    if let Some(message) = messages.last() {
        request["newest"] = json!({"ordinal":message["ordinal"],"mid":message["mid"]});
    }
    request
}

pub fn render(view: &Value, transcript: &[Value]) -> Vec<u8> {
    let from = view["range"]["from"].as_u64().unwrap();
    let to = view["range"]["to"].as_u64().unwrap();
    let mut messages = Vec::new();
    let mut inserted = false;
    for entry in transcript {
        let ordinal = entry["ordinal"].as_u64().unwrap();
        if !inserted && ordinal >= from {
            messages.extend(view["replacement"].as_array().unwrap().iter().cloned());
            inserted = true;
        }
        if ordinal < from || ordinal >= to {
            messages.push(entry["message"].clone());
        }
    }
    if !inserted {
        messages.extend(view["replacement"].as_array().unwrap().iter().cloned());
    }
    serde_json::to_vec(&messages).unwrap()
}

pub fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/broca_conformance/fixtures/compaction-provider-v1/joint")
}
