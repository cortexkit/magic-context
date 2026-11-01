use super::*;
use crate::historian_producer::{HistorianProducer, HistorianProducerConfig};
use crate::route_targets::{RouteTargetConfig, SessionRunnerRoute};
use subc_control::{ClientControlRequest, ClientControlResponse};
use subc_protocol::{Flags, Frame, FrameType, Priority, RouteTarget};
use subc_transport::{
    authenticate_server, generate_daemon_id, generate_key, read_frame, write_atomic, write_frame,
    ConnectionInfo, Endpoint, SCHEMA_VERSION,
};
use tokio::net::TcpListener;

type RecordedRoute = (
    RouteTarget,
    subc_protocol::BindIdentity,
    Option<BTreeMap<String, String>>,
);

#[derive(Default)]
struct WireLog {
    routes: Vec<RecordedRoute>,
    describes: usize,
    sends: Vec<Value>,
}

struct Server {
    root: tempfile::TempDir,
    log: Arc<Mutex<WireLog>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Server {
    async fn new(description: Value) -> Self {
        let root = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let key = generate_key().unwrap();
        let daemon_id = generate_daemon_id().unwrap();
        write_atomic(
            root.path().join("connection.json"),
            &ConnectionInfo {
                schema: SCHEMA_VERSION,
                wire_version: Some(subc_protocol::PROTOCOL_VERSION),
                endpoints: vec![Endpoint {
                    host: addr.ip().to_string(),
                    port: addr.port(),
                }],
                key: key.clone(),
                daemon_id,
                pid: std::process::id(),
                daemon_ver: "0.39.0".into(),
            },
        )
        .unwrap();
        let log = Arc::new(Mutex::new(WireLog::default()));
        let recorded = log.clone();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            authenticate_server(
                &mut stream,
                &key,
                &daemon_id,
                "describe-fixture",
                Duration::from_secs(2),
            )
            .await
            .unwrap();
            let mut next_route = 10;
            while let Some(frame) = read_frame(&mut stream).await.unwrap() {
                if frame.header.ty != FrameType::Request {
                    continue;
                }
                let answer = if frame.header.channel == 0 {
                    let request: ClientControlRequest =
                        serde_json::from_slice(&frame.body).unwrap();
                    let ClientControlRequest::RouteOpen {
                        target,
                        identity,
                        role_versions,
                        ..
                    } = request
                    else {
                        panic!("unexpected control request")
                    };
                    recorded
                        .lock()
                        .unwrap()
                        .routes
                        .push((target, identity, role_versions));
                    let channel = next_route;
                    next_route += 1;
                    serde_json::to_value(ClientControlResponse::RouteOpen {
                        route_channel: channel,
                        route_epoch: 1,
                    })
                    .unwrap()
                } else {
                    let request: Value = serde_json::from_slice(&frame.body).unwrap();
                    match request["method"].as_str().unwrap() {
                        "role.describe" => {
                            recorded.lock().unwrap().describes += 1;
                            json!({"result": description})
                        }
                        "session.send" => {
                            recorded
                                .lock()
                                .unwrap()
                                .sends
                                .push(request["params"].clone());
                            json!({"result":{"state":"active","run_id":"run-1"}})
                        }
                        operation => panic!("unexpected historian operation: {operation}"),
                    }
                };
                let response = Frame::build(
                    FrameType::Response,
                    Flags::new(false, Priority::Interactive, false),
                    frame.header.channel,
                    frame.header.epoch,
                    frame.header.corr,
                    serde_json::to_vec(&answer).unwrap(),
                )
                .unwrap();
                write_frame(&mut stream, &response).await.unwrap();
            }
        });
        Self { root, log, task }
    }

    fn config(&self) -> HistorianProducerConfig {
        HistorianProducerConfig {
            connection_file: self.root.path().join("connection.json"),
            project_root: self.root.path().into(),
            harness: "opencode".into(),
            route_targets: RouteTargetConfig::runner_module("configured-broca"),
            handshake_timeout: Duration::from_secs(2),
            request_timeout: Duration::from_secs(2),
            await_timeout: Duration::from_secs(2),
            child_scope: Some(crate::child_scopes::test_selector(self.root.path())),
        }
    }
}

async fn exercise(session_owned: bool) {
    for (name, writer, description) in captures() {
        let server = Server::new(description).await;
        let mut producer = if session_owned {
            let principal = subc_protocol::Principal::Reserved {
                module_id: "broca".into(),
            };
            let route =
                SessionRunnerRoute::for_principal(Some(&principal), "foreground-parent").unwrap();
            HistorianProducer::connect_to_session_runner(server.config(), route)
                .await
                .unwrap()
        } else {
            HistorianProducer::connect(server.config()).await.unwrap()
        };
        let expected = crate::runner_limits::RunnerLimits {
            max_steps: true,
            no_tools: true,
            max_output_tokens: false,
        };
        assert_eq!(
            producer
                .session_runner_limits("background-child")
                .await
                .unwrap(),
            Some(expected),
            "{name}"
        );
        assert_eq!(
            producer
                .session_runner_limits("background-child")
                .await
                .unwrap(),
            Some(expected),
            "{name}"
        );
        assert_eq!(
            producer
                .start("background-child", "system", "prompt", "provider/model")
                .await
                .unwrap()
                .run_id,
            "run-1",
            "{name}"
        );
        producer.close().await;
        let log = server.log.lock().unwrap();
        assert_eq!(log.describes, 1, "{name}: route-local discovery is cached");
        assert_eq!(log.routes.len(), 1, "{name}");
        let (target, identity, versions) = &log.routes[0];
        assert_eq!(
            target,
            &RouteTarget::ManagementSurface {
                module_id: if session_owned {
                    "broca"
                } else {
                    "configured-broca"
                }
                .into()
            },
            "{name}"
        );
        assert_eq!(identity.session, "background-child", "{name}");
        assert_eq!(identity.harness, "opencode", "{name}");
        assert_eq!(
            versions,
            &Some(BTreeMap::from([("llm-runner".into(), "v1".into())])),
            "{name}"
        );
        assert_eq!(log.sends.len(), 1, "{name}");
        let send = &log.sends[0];
        assert_eq!(send["tools"], json!([]), "{name}");
        assert_eq!(send["stop_when"], json!({"max_steps":1}), "{name}");
        assert!(send.get("parent").is_none(), "{name}");
        assert_eq!(
            send.get("retention"),
            writer.then_some(&json!(86_400)),
            "{name}"
        );
    }
}

#[tokio::test]
async fn broca_role_describe_historian_discovery_retention_and_configured_route() {
    exercise(false).await;
}

#[tokio::test]
async fn broca_role_describe_background_child_runner_routing() {
    exercise(true).await;
}
