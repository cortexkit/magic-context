//! First plan fetch over the real daemon/SDK route, before any transform.
//!
//! The SDK awaits on_hello_ack before entering its frame loop, but McHandler's
//! callback only starts StoreOpenCoordinator's background task. on_bind does not
//! wait for that task. Holding its test barrier makes this ordering deterministic.

use super::*;
use std::sync::atomic::AtomicBool;
use subc_client_rs::{CallOptions, ConsumerOptions, SubcConsumer};
use subc_daemon::{serve_listener, ConnectedClients, ControlHandler, Registry, Router, ServerAuth};
use subc_protocol::BindIdentity;
use subc_transport::{
    generate_daemon_id, generate_key, write_atomic, ConnectionInfo, Endpoint, SCHEMA_VERSION,
};
use tokio::net::TcpListener;

struct Observer {
    handler: Arc<McHandler>,
    gate: Arc<Notify>,
    release_on_catalog: bool,
    bind_before_open: Arc<AtomicBool>,
    catalog_before_open: Arc<AtomicBool>,
    transforms: Arc<AtomicU64>,
}

#[async_trait]
impl ModuleHandler for Observer {
    async fn on_hello_ack(&self, ack: &ModuleHelloAckBody) {
        self.handler.on_hello_ack(ack).await;
    }

    async fn on_bind(&self, request: &RouteBindRequest) -> subc_client_rs::BindDecision {
        self.bind_before_open
            .store(self.handler.store.get().is_none(), Ordering::Release);
        self.handler.on_bind(request).await
    }

    async fn handle(&self, ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome {
        let request: Value = serde_json::from_slice(&body).unwrap();
        if request.get("name").and_then(Value::as_str) == Some("tool.catalog") {
            self.catalog_before_open
                .store(self.handler.store.get().is_none(), Ordering::Release);
            if self.release_on_catalog {
                self.gate.notify_one();
            }
        }
        if request
            .get("kind")
            .or(request.get("method"))
            .and_then(Value::as_str)
            == Some("transform")
        {
            self.transforms.fetch_add(1, Ordering::Relaxed);
        }
        self.handler.handle(ctx, body).await
    }
}

enum StoreCondition {
    Fresh,
    Ahead,
    Damaged,
    Delayed,
}

struct LiveRoute {
    consumer: SubcConsumer,
    handler: Arc<McHandler>,
    identity: BindIdentity,
    gate: Arc<Notify>,
    bind_before_open: Arc<AtomicBool>,
    catalog_before_open: Arc<AtomicBool>,
    transforms: Arc<AtomicU64>,
    module: tokio::task::JoinHandle<Result<(), subc_client_rs::SubcModuleError>>,
    daemon: tokio::task::JoinHandle<Result<(), subc_daemon::ServerError>>,
    _dir: tempfile::TempDir,
}

impl Drop for LiveRoute {
    fn drop(&mut self) {
        self.handler.store_open.cancel();
        self.gate.notify_one();
        self.module.abort();
        self.daemon.abort();
    }
}

impl LiveRoute {
    async fn start(condition: StoreCondition) -> Self {
        let dir = tempfile::tempdir().unwrap();
        // The authenticated transport rejects a group-writable parent. Tempfile
        // inherits the host umask, so tighten only this owned throwaway root.
        assert_eq!(
            mc_store::private_permissions::tighten_directory(dir.path(), true).failures,
            0
        );
        let data = dir.path().join("data");
        let project = dir.path().join("project");
        mc_store::private_permissions::ensure_directory(&data, true).unwrap();
        mc_store::private_permissions::ensure_directory(&project, true).unwrap();
        let project = std::fs::canonicalize(project).unwrap();
        let storage = subc_daemon::daemon_config::StorageConfig::Sqlite { data_home: data };
        let descriptor: StorageDescriptor =
            serde_json::from_value(storage.descriptor_for(DEFAULT_MODULE_ID)).unwrap();
        match condition {
            StoreCondition::Ahead => {
                let store = McStore::open_for_test(&descriptor).unwrap();
                store
                    .stamp_schema_version_for_test(LATEST_MIGRATION_VERSION + 1)
                    .unwrap();
            }
            StoreCondition::Damaged => {
                let StorageBackend::Sqlite { path } = &descriptor.backend else {
                    unreachable!()
                };
                mc_store::private_permissions::ensure_directory(
                    Path::new(path).parent().unwrap(),
                    true,
                )
                .unwrap();
                mc_store::private_permissions::write_file(
                    Path::new(path),
                    b"not a sqlite database",
                    true,
                )
                .unwrap();
            }
            _ => {}
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let connection_file = dir.path().join("subc-connection.json");
        let connection = ConnectionInfo {
            schema: SCHEMA_VERSION,
            wire_version: Some(PROTOCOL_VERSION),
            endpoints: vec![Endpoint {
                host: "127.0.0.1".into(),
                port: listener.local_addr().unwrap().port(),
            }],
            key: generate_key().unwrap(),
            daemon_id: generate_daemon_id().unwrap(),
            pid: std::process::id(),
            daemon_ver: "catalog-startup-test".into(),
        };
        write_atomic(&connection_file, &connection).unwrap();
        let connected = ConnectedClients::new();
        let control = Arc::new(
            ControlHandler::new(Arc::new(Registry::default()))
                .with_storage_config(Some(storage))
                .with_connected_clients(connected.clone()),
        );
        let router = Arc::new(Router::with_control_handler(control));
        let auth = ServerAuth::new(connection.key, connection.daemon_id, connection.daemon_ver)
            .with_connected_clients(connected);
        let daemon = tokio::spawn(serve_listener(listener, router, auth));

        let mut handler = McHandler::new();
        assert!(
            handler.store.get().is_none(),
            "construction must not open the store"
        );
        handler.fixed_config = Some(super::tool_catalog::example_module_config());
        handler.set_store_open_policy_for_test(StoreOpenPolicy {
            request_wait: if matches!(condition, StoreCondition::Delayed) {
                Duration::from_millis(25)
            } else {
                Duration::from_secs(10)
            },
            ..Default::default()
        });
        let gate = Arc::new(Notify::new());
        *handler.store_open.open_gate.lock().unwrap() = Some(Arc::clone(&gate));
        let handler = Arc::new(handler);
        let bind_before_open = Arc::new(AtomicBool::new(false));
        let catalog_before_open = Arc::new(AtomicBool::new(false));
        let transforms = Arc::new(AtomicU64::new(0));
        let observer = Observer {
            handler: Arc::clone(&handler),
            gate: Arc::clone(&gate),
            release_on_catalog: !matches!(condition, StoreCondition::Delayed),
            bind_before_open: Arc::clone(&bind_before_open),
            catalog_before_open: Arc::clone(&catalog_before_open),
            transforms: Arc::clone(&transforms),
        };
        let (_, serve) = subc_client_rs::serve_with_handle(
            &connection_file,
            manifest(DEFAULT_MODULE_ID),
            observer,
        )
        .await
        .unwrap();
        assert_eq!(
            handler.store_open.phase.load(Ordering::Acquire),
            STORE_OPENING
        );
        assert!(
            handler.store.get().is_none(),
            "HELLO_ACK started, but did not await, the open"
        );
        let module = tokio::spawn(serve);
        let consumer = SubcConsumer::connect(&connection_file, ConsumerOptions::default())
            .await
            .unwrap();
        Self {
            consumer,
            handler,
            identity: BindIdentity::new(project, session_resolver::RUNNER_BIND_HARNESS, "s"),
            gate,
            bind_before_open,
            catalog_before_open,
            transforms,
            module,
            daemon,
            _dir: dir,
        }
    }

    async fn call(&self, request: Value) -> Result<Vec<u8>, subc_client_rs::CallError> {
        self.consumer
            .call(
                crate::route_targets::catalog_provider_target_for_test(),
                self.identity.clone(),
                serde_json::to_vec(&request).unwrap(),
                CallOptions {
                    timeout: Duration::from_secs(20),
                    ..Default::default()
                },
            )
            .await
    }

    async fn catalog(&self) -> Vec<u8> {
        let request: Value = serde_json::from_str(include_str!(
            "../../../../docs/designs/mc-tool-catalog-v1/head-full.request.json"
        ))
        .unwrap();
        let bytes = self
            .call(json!({"name":"tool.catalog","arguments":request}))
            .await
            .unwrap();
        assert_eq!(
            bytes,
            include_bytes!("../../../../docs/designs/mc-tool-catalog-v1/head-full.answer.jcs")
        );
        bytes
    }

    async fn setup(&self) -> Result<Vec<u8>, subc_client_rs::CallError> {
        self.call(json!({"method":"compaction.setup","params":{"session":"s","harness":"broca","request_id":"setup",
            "params":{},"composition":{},"model":"fixture","context_window":100_000,"now":1}})).await
    }

    fn assert_catalog_before_store_and_transform(&self) {
        assert!(self.bind_before_open.load(Ordering::Acquire));
        assert!(self.catalog_before_open.load(Ordering::Acquire));
        assert_eq!(self.transforms.load(Ordering::Relaxed), 0);
        assert_eq!(
            self.handler
                .store_open
                .waiter_starts
                .load(Ordering::Relaxed),
            1
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_composition_catalog_on_a_real_route_awaits_the_startup_open_without_transform() {
    let route = LiveRoute::start(StoreCondition::Fresh).await;
    route.catalog().await;
    route.assert_catalog_before_store_and_transform();
    let store = route
        .handler
        .store
        .get()
        .expect("catalog joined the coordinator's open");
    assert!(store
        .load_provider_catalog(&route.identity.project_root.to_string_lossy(), "s")
        .unwrap()
        .is_some());
    let setup: Value = serde_json::from_slice(&route.setup().await.unwrap()).unwrap();
    assert_eq!(setup["answer"], "ready");
    route.consumer.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn catalog_store_faults_preserve_pin_bytes_and_refuse_provider_by_name() {
    for condition in [StoreCondition::Ahead, StoreCondition::Damaged] {
        let route = LiveRoute::start(condition).await;
        route.catalog().await;
        route.assert_catalog_before_store_and_transform();
        assert!(route.handler.store.get().is_none());
        assert_eq!(
            route.setup().await.unwrap_err().code(),
            Some("provider_catalog_unpersisted")
        );
        // Once the failure is known, a second fetch must still bypass a fence
        // refusal rather than changing the catalog into a storage error.
        route.catalog().await;
        route.consumer.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unpersisted_catalog_blocks_provider_even_after_open_until_a_full_refetch() {
    let route = LiveRoute::start(StoreCondition::Delayed).await;
    route.catalog().await;
    route.assert_catalog_before_store_and_transform();
    assert!(route.handler.store.get().is_none());
    route.gate.notify_one();
    route
        .handler
        .set_store_open_policy_for_test(StoreOpenPolicy {
            request_wait: Duration::from_secs(10),
            ..Default::default()
        });
    route.handler.store_for_request().await.unwrap();
    assert_eq!(
        route.setup().await.unwrap_err().code(),
        Some("provider_catalog_unpersisted")
    );
    route.catalog().await;
    let setup: Value = serde_json::from_slice(&route.setup().await.unwrap()).unwrap();
    assert_eq!(setup["answer"], "ready");
    route.consumer.close().await;
}
