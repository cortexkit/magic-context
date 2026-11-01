use super::*;
use std::{os::unix::fs::PermissionsExt, path::PathBuf, time::Duration};
use subc_client_rs::{HandlerOutcome, ModuleHandler, RequestCtx};
use subc_daemon::supervise::{ModuleSpec, RestartPolicy, Supervisor, SupervisorHandle};
use subc_daemon::{serve_listener, ConnectedClients, ControlHandler, Registry, Router, ServerAuth};
use subc_transport::{
    generate_daemon_id, generate_key, write_atomic, ConnectionInfo, Endpoint, SCHEMA_VERSION,
};

const OWNER: &str = "mc-scope-owner-test";

struct Idle;
#[async_trait]
impl ModuleHandler for Idle {
    async fn handle(&self, _: RequestCtx, _: Vec<u8>) -> HandlerOutcome {
        HandlerOutcome::Response(b"{}".to_vec())
    }
}

#[tokio::test]
async fn scope_owner_process() {
    let Some(report) = std::env::var_os("MC_SCOPE_OWNER_REPORT") else {
        return;
    };
    assert!(
        subc_os::launch_nonce().unwrap().is_some(),
        "supervised helper must inherit its launch nonce"
    );
    let connection = PathBuf::from(std::env::var_os("MC_SCOPE_OWNER_CONNECTION").unwrap());
    let root = PathBuf::from(std::env::var_os("MC_SCOPE_OWNER_PROJECT").unwrap());
    let (handle, serve) =
        subc_client_rs::serve_with_handle(&connection, crate::manifest(OWNER), Idle)
            .await
            .unwrap();
    let serving = tokio::spawn(serve);
    let scopes = ChildScopes::new(OWNER);
    scopes.install(handle.clone());
    let first = scopes
        .for_project(&root)
        .await
        .unwrap_or_else(|error| panic!("owned scope sync refused: {error}"));
    let second = scopes.for_project(&root).await.unwrap();
    assert_eq!(first, second);
    assert_eq!(scopes.state.lock().await.generation, 1);
    let described = handle
        .scope_describe(first.owner.clone(), first.scope_ref.clone())
        .await
        .unwrap();
    let record = described.scope.unwrap();
    assert_eq!(record.workdir.as_deref(), root.to_str());
    let report = PathBuf::from(report);
    let pending = report.with_extension("pending");
    std::fs::write(
        &pending,
        serde_json::to_vec(
            &serde_json::json!({"workdir":record.workdir,"generation":1,"scope":first}),
        )
        .unwrap(),
    )
    .unwrap();
    std::fs::rename(pending, report).unwrap();
    serving.abort();
}

#[tokio::test]
async fn supervised_module_handle_publishes_and_reuses_its_own_project_scope() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        mc_store::private_permissions::tighten_directory(dir.path(), true).failures,
        0
    );
    let root = dir.path().join("project");
    mc_store::private_permissions::ensure_directory(&root, true).unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let connection_file = dir.path().join("connection.json");
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
    write_atomic(&connection_file, &connection).unwrap();
    let registry = Arc::new(Registry::default());
    let supervisor_handle = SupervisorHandle::new();
    let supervisor = Supervisor::new(
        registry.clone(),
        RestartPolicy::new(0, Duration::from_millis(10)),
    )
    .with_handle(supervisor_handle.clone())
    .with_connection_file_path(&connection_file)
    .with_live_children_record(dir.path().join("children.json"))
    .with_capture_logs_dir(dir.path().join("logs"))
    .with_drain_timeout(Duration::from_secs(1));
    let connected = ConnectedClients::new();
    let control = Arc::new(
        ControlHandler::new(registry)
            .with_supervisor(supervisor_handle)
            .with_connected_clients(connected.clone()),
    );
    let router = Arc::new(Router::with_control_handler(control));
    let auth = ServerAuth::new(connection.key, connection.daemon_id, connection.daemon_ver)
        .with_connected_clients(connected);
    let daemon = tokio::spawn(serve_listener(listener, router, auth));
    let script = dir.path().join("scope-owner.sh");
    mc_store::private_permissions::write_file(&script, b"#!/bin/sh\nexec \"$MC_SCOPE_OWNER_EXE\" --exact child_scopes::supervised_tests::scope_owner_process --nocapture\n", true).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let report = dir.path().join("scope.json");
    let module = supervisor
        .supervise_configured(
            ModuleSpec {
                module_id: OWNER.into(),
                program: script,
                args: Vec::new(),
                env: vec![
                    (
                        "MC_SCOPE_OWNER_EXE".into(),
                        std::env::current_exe()
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                    ),
                    (
                        "MC_SCOPE_OWNER_REPORT".into(),
                        report.to_string_lossy().into_owned(),
                    ),
                    (
                        "MC_SCOPE_OWNER_CONNECTION".into(),
                        connection_file.to_string_lossy().into_owned(),
                    ),
                    (
                        "MC_SCOPE_OWNER_PROJECT".into(),
                        root.to_string_lossy().into_owned(),
                    ),
                ],
                reserved: false,
                reserved_prefixes: Vec::new(),
                protocol: subc_control::ModuleProtocol::Subc,
                overlap: Default::default(),
            },
            true,
        )
        .unwrap();
    let ready = tokio::time::timeout(Duration::from_secs(10), async {
        while !report.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    let stderr = module.stderr_tail(None, None);
    let _ = module.stop().await;
    daemon.abort();
    assert!(
        ready.is_ok(),
        "supervised scope owner did not publish: {stderr:?}"
    );
    let result: serde_json::Value =
        serde_json::from_slice(&std::fs::read(report).unwrap()).unwrap();
    assert_eq!(result["generation"], 1);
    assert_eq!(result["workdir"], root.to_str().unwrap());
    assert_eq!(result["scope"]["owner"]["module_id"], OWNER);
}
