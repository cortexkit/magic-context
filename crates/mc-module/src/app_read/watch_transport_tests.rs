//! The real daemon, provider adapter and consumer subscription wire, not a Hub mock.
use super::*;
use crate::{transport_handler::McTransportHandler, McHandler};
use subc_client_rs::{
    async_trait, CallOptions, ConsumerOptions, ModuleHandler, RequestCtx, RouteBindRequest,
    RouteHandle, SubcConsumer, SubscribeOptions, SubscriptionEnd,
};
use subc_daemon::{serve_listener, ConnectedClients, ControlHandler, Registry, Router, ServerAuth};
use subc_protocol::{BindIdentity, RouteTarget};
use subc_transport::{
    generate_daemon_id, generate_key, write_atomic, ConnectionInfo, Endpoint, SCHEMA_VERSION,
};

struct Serving(Arc<McHandler>);
#[async_trait]
impl ModuleHandler for Serving {
    async fn on_bind(&self, request: &RouteBindRequest) -> subc_client_rs::BindDecision {
        self.0.on_bind(request).await
    }
    async fn on_route_gone(&self, route: &RouteHandle) {
        self.0.on_route_gone(route).await
    }
    async fn handle(&self, ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome {
        self.0.handle(ctx, body).await
    }
}

struct Rig {
    consumer: SubcConsumer,
    handler: Arc<McHandler>,
    identity: BindIdentity,
    module: tokio::task::JoinHandle<Result<(), subc_client_rs::SubcModuleError>>,
    daemon: tokio::task::JoinHandle<Result<(), subc_daemon::ServerError>>,
    dir: tempfile::TempDir,
}
impl Drop for Rig {
    fn drop(&mut self) {
        self.module.abort();
        self.daemon.abort();
    }
}
impl Rig {
    async fn start() -> Self {
        Self::start_configured(|_, _| {}).await
    }
    async fn start_configured(configure: impl FnOnce(&mut McHandler, &std::path::Path)) -> Self {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            mc_store::private_permissions::tighten_directory(dir.path(), true).failures,
            0
        );
        let mut handler = McHandler::new();
        handler
            .store
            .set(super::super::tests_support::open_store(dir.path()))
            .ok()
            .unwrap();
        super::super::tests_support::apply_sql(
            &dir.path().join("context.db"),
            "INSERT INTO session_meta(session_id,harness) VALUES('s','opencode');",
        );
        configure(&mut handler, dir.path());
        let handler = Arc::new(handler);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let file = dir.path().join("connection.json");
        let connection = ConnectionInfo {
            schema: SCHEMA_VERSION,
            wire_version: Some(subc_protocol::PROTOCOL_VERSION),
            endpoints: vec![Endpoint {
                host: "127.0.0.1".into(),
                port: listener.local_addr().unwrap().port(),
            }],
            key: generate_key().unwrap(),
            daemon_id: generate_daemon_id().unwrap(),
            pid: std::process::id(),
            daemon_ver: "0.39.0".into(),
        };
        write_atomic(&file, &connection).unwrap();
        let connected = ConnectedClients::new();
        let control = Arc::new(
            ControlHandler::new(Arc::new(Registry::default()))
                .with_connected_clients(connected.clone()),
        );
        let router = Arc::new(Router::with_control_handler(control));
        let auth = ServerAuth::new(connection.key, connection.daemon_id, connection.daemon_ver)
            .with_connected_clients(connected);
        let daemon = tokio::spawn(serve_listener(listener, router, auth));
        // The fixture already installed its serving store. Forward no HELLO_ACK
        // to McHandler, whose production hook would start a different store open.
        let (_, serve) = subc_client_rs::serve_with_handle(
            &file,
            crate::manifest(crate::DEFAULT_MODULE_ID),
            McTransportHandler::new(Serving(Arc::clone(&handler))),
        )
        .await
        .unwrap();
        let module = tokio::spawn(serve);
        let consumer = SubcConsumer::connect(&file, ConsumerOptions::default())
            .await
            .unwrap();
        let identity = BindIdentity::new("desktop", "ignored");
        Self {
            consumer,
            handler,
            identity,
            module,
            daemon,
            dir,
        }
    }
    fn target(&self, management: bool) -> RouteTarget {
        if management {
            RouteTarget::ManagementSurface {
                module_id: crate::DEFAULT_MODULE_ID.into(),
            }
        } else {
            crate::route_targets::app_read_target_for_test(crate::DEFAULT_MODULE_ID)
        }
    }
    async fn subscribe(
        &self,
        management: bool,
        cursor: Option<&str>,
    ) -> subc_client_rs::Subscription {
        let mut params =
            json!({"sessions":[{"runner":"opencode","harness":"opencode","session":"s"}]});
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }
        self.consumer
            .subscribe(
                self.target(management),
                self.identity.clone(),
                serde_json::to_vec(&json!({"method":METHOD,"params":params})).unwrap(),
                SubscribeOptions::default(),
            )
            .await
            .unwrap()
    }
    async fn slots(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self
                .handler
                .context_watches
                .state
                .lock()
                .unwrap()
                .subscribers
                .len()
                != count
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}

#[path = "watch_samples.rs"]
pub(super) mod sample_fixtures;
async fn event(sub: &mut subc_client_rs::Subscription, management: bool) -> Value {
    let bytes = tokio::time::timeout(Duration::from_secs(5), sub.events().recv())
        .await
        .unwrap()
        .unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    if management {
        assert_eq!(value.as_object().unwrap().len(), 1);
        value["result"].clone()
    } else {
        value
    }
}

#[tokio::test]
async fn unscoped_management_watch_uses_the_named_session() {
    if super::super::tests::isolated(
        "app_read::watch::transport_tests::unscoped_management_watch_uses_the_named_session",
    ) {
        return;
    }
    let rig = Rig::start().await;
    let mut watch = rig.subscribe(true, None).await;
    let initial = event(&mut watch, true).await;
    assert_eq!(initial["kind"], "resync");
    assert!(rig
        .handler
        .route_identities
        .lock()
        .unwrap()
        .values()
        .all(|route| route.scope.is_none()));
    assert!(rig.handler.bindings.lock().unwrap().is_empty());
    super::super::tests_support::apply_sql(
        &rig.dir.path().join("context.db"),
        "UPDATE session_meta SET counter=1 WHERE session_id='s'",
    );
    assert_eq!(event(&mut watch, true).await["kind"], "changes");
    watch.unsubscribe().unwrap();
    rig.slots(0).await;
}

#[tokio::test]
async fn daemon_subscription_streams_and_drop_cancel_route_close_release_slots() {
    if super::super::tests::isolated("app_read::watch::transport_tests::daemon_subscription_streams_and_drop_cancel_route_close_release_slots") { return; }
    let rig = Rig::start().await;
    let mut direct = rig.subscribe(false, None).await;
    let initial = event(&mut direct, false).await;
    assert_eq!(initial["kind"], "resync");
    let mut management = rig.subscribe(true, initial["cursor"].as_str()).await;
    assert_eq!(event(&mut management, true).await["kind"], "changes");
    let read = serde_json::to_vec(&json!({"method":"session_data.read","params":{"session":{"runner":"opencode","harness":"opencode","session":"s"},"section":"meta"}})).unwrap();
    let before = rig
        .consumer
        .call(
            rig.target(false),
            rig.identity.clone(),
            read.clone(),
            CallOptions::default(),
        )
        .await
        .unwrap();
    let before: Value = serde_json::from_slice(&before).unwrap();
    assert_eq!(before["row"]["counter"], 0);
    super::super::tests_support::apply_sql(
        &rig.dir.path().join("context.db"),
        "UPDATE session_meta SET counter=1 WHERE session_id='s'",
    );
    let changed = event(&mut direct, false).await;
    assert_eq!(changed["kind"], "changes");
    assert_eq!(event(&mut management, true).await, changed);
    let after = rig
        .consumer
        .call(
            rig.target(false),
            rig.identity.clone(),
            read,
            CallOptions::default(),
        )
        .await
        .unwrap();
    let after: Value = serde_json::from_slice(&after).unwrap();
    assert_eq!(after["row"]["counter"], 1);
    drop(direct);
    rig.slots(1).await;
    management.unsubscribe().unwrap();
    rig.slots(0).await;
    let mut again = rig.subscribe(false, changed["cursor"].as_str()).await;
    assert_eq!(event(&mut again, false).await["kind"], "resync");
    rig.consumer
        .close_route(
            rig.target(false),
            rig.identity.clone(),
            subc_client_rs::CloseRouteOptions::default(),
        )
        .await;
    rig.slots(0).await;
}

#[tokio::test]
async fn daemon_subscription_reports_named_quota_and_lagged_errors() {
    if super::super::tests::isolated("app_read::watch::transport_tests::daemon_subscription_reports_named_quota_and_lagged_errors") { return; }
    let rig = Rig::start().await;
    let mut subscriptions = Vec::new();
    for _ in 0..PER_CALLER {
        let mut sub = rig.subscribe(false, None).await;
        event(&mut sub, false).await;
        subscriptions.push(sub);
    }
    let mut refused = rig.subscribe(false, None).await;
    let end = tokio::time::timeout(Duration::from_secs(5), refused.ended())
        .await
        .unwrap();
    assert!(
        matches!(end,SubscriptionEnd::Error(ref error) if error.code == "watch_limit_exceeded"),
        "{end:?}"
    );
    let k = ("opencode".into(), "opencode".into(), "s".into());
    // Fill the provider queue without yielding to its forwarders, so this
    // proves the provider's `lagged`, not consumer-local backpressure.
    for i in 0..=QUEUE {
        rig.handler.context_watches.publish(
            BTreeMap::from([(
                k.clone(),
                Snapshot {
                    digest: i.to_le_bytes().to_vec(),
                    deadline: None,
                },
            )]),
            false,
        );
    }
    for mut sub in subscriptions {
        let end = tokio::time::timeout(Duration::from_secs(5), sub.ended())
            .await
            .unwrap();
        assert!(
            matches!(end,SubscriptionEnd::Error(ref error) if error.code == "lagged"),
            "{end:?}"
        );
    }
    rig.slots(0).await;
}
