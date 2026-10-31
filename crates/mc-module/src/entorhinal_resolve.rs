//! Choose a registered project identity through Entorhinal once per session or route bind.
//! The caller retains that decision. Keeping it out of the process's git/directory cache
//! lets later sessions retry the service without changing an earlier session's identity.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use mc_store::McStore;
use serde::Deserialize;
use subc_client_rs::{
    CallError, CallOptions, CloseRouteOptions, ConsumerOptions, RetryBackoff, SubcConsumer,
};
use subc_protocol::{BindIdentity, RouteTarget};

use crate::project_identity::{
    is_project_pin, log_once, ProjectIdentityError, ProjectIdentityResolver,
};

use crate::route_targets::{RegisteredRoute, RouteTargetConfig};

pub const ENTORHINAL_RESOLVE_DEADLINE_MS: u64 = 500;
const DEADLINE: Duration = Duration::from_millis(ENTORHINAL_RESOLVE_DEADLINE_MS);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveAnswer {
    Absent,
    NotAnswering,
    Implicit,
    Registered {
        project_id: String,
        canonical_root: Option<PathBuf>,
        root_registered: bool,
    },
}

/// The route uses the caller's bind identity, not a service id.
pub fn route_target() -> RouteTarget {
    RouteTargetConfig::default()
        .target(RegisteredRoute::EntorhinalResolve)
        .expect("Entorhinal resolve always has a registered target")
}

/// A missing connection file is absence; an existing but unreachable daemon is not.
pub struct EntorhinalResolver {
    connection_file: Option<PathBuf>,
}

type ConsumerSlot = tokio::sync::Mutex<Option<SubcConsumer>>;

fn consumer_slot(path: &Path) -> Arc<ConsumerSlot> {
    static CONSUMERS: OnceLock<Mutex<HashMap<PathBuf, Arc<ConsumerSlot>>>> = OnceLock::new();
    CONSUMERS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap()
        .entry(path.to_path_buf())
        .or_default()
        .clone()
}

// A cancelled or failed attempt must not put a potentially broken consumer back
// in the process cache. Closing asynchronously also covers the outer resolve deadline.
struct ConsumerLease(Option<SubcConsumer>);

impl Drop for ConsumerLease {
    fn drop(&mut self) {
        if let Some(consumer) = self.0.take() {
            tokio::spawn(async move {
                consumer.close().await;
            });
        }
    }
}

impl EntorhinalResolver {
    pub fn new(connection_file: Option<PathBuf>) -> Self {
        Self { connection_file }
    }

    pub async fn resolve_for_session(
        &self,
        identities: &ProjectIdentityResolver,
        directory: &Path,
        harness: &str,
        instance_token: &str,
        store: Option<&McStore>,
    ) -> Result<String, ProjectIdentityError> {
        resolve_with_store_attempt(
            identities,
            directory,
            store,
            self.attempt(directory, harness, instance_token),
        )
        .await
    }

    async fn attempt(
        &self,
        directory: &Path,
        harness: &str,
        instance_token: &str,
    ) -> ResolveAnswer {
        let Some(connection_file) = self.connection_file.as_deref().filter(|file| file.exists())
        else {
            return ResolveAnswer::Absent;
        };
        let slot = consumer_slot(connection_file);
        let mut cached = slot.lock().await;
        let consumer = if let Some(consumer) = cached.take() {
            consumer
        } else {
            match SubcConsumer::connect(
                connection_file,
                ConsumerOptions {
                    handshake_timeout: DEADLINE,
                    call_timeout: DEADLINE,
                    reconnect_backoff: retry_backoff(),
                    ..ConsumerOptions::default()
                },
            )
            .await
            {
                Ok(consumer) => consumer,
                Err(error) => {
                    log_once(
                        format!("entorhinal-connect:{error}"),
                        "Entorhinal is not answering",
                    );
                    return ResolveAnswer::NotAnswering;
                }
            }
        };
        let mut lease = ConsumerLease(Some(consumer));
        let consumer = lease.0.as_ref().unwrap();
        let root = std::fs::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf());
        let identity = BindIdentity::new(harness, instance_token);
        let response = consumer
            .call(
                route_target(),
                identity.clone(),
                serde_json::to_vec(&serde_json::json!({
                    "method": "resolve", "params": { "canonicalRoot": root }
                }))
                .expect("resolve request is JSON"),
                CallOptions {
                    timeout: DEADLINE,
                    route_retry: retry_backoff(),
                    route_retry_deadline: DEADLINE,
                    ..CallOptions::default()
                },
            )
            .await;
        // Only the caller persists a selected identity, after checking the outer
        // deadline. Cancelling this transport attempt cannot publish a late pin.
        // Routes are session-scoped, but the transport is process-scoped. Retire
        // each bind's route without closing the healthy shared connection.
        if response.is_ok() || matches!(&response, Err(CallError::Module(_))) {
            consumer
                .close_route(route_target(), identity, CloseRouteOptions::default())
                .await;
            *cached = lease.0.take();
        }
        match response {
            Ok(bytes) => decode_reply(&bytes),
            Err(error) => classify_call_error(error),
        }
    }
}

fn retry_backoff() -> RetryBackoff {
    RetryBackoff {
        base: Duration::from_millis(25),
        cap: Duration::from_millis(50),
        max_attempts: 1,
    }
}

fn classify_call_error(error: CallError) -> ResolveAnswer {
    match error {
        CallError::Module(body) if body.code == "unknown_module" => ResolveAnswer::Absent,
        other => {
            log_once(
                format!("entorhinal-call:{other}"),
                "Entorhinal is not answering",
            );
            ResolveAnswer::NotAnswering
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireResolution {
    project_id: String,
    via: String,
    canonical_root: Option<PathBuf>,
    // Validate the stable required fields. Registration metadata such as rootRecords
    // and future fields do not participate in identity selection and can be ignored.
    #[serde(rename = "gone")]
    _gone: bool,
    #[serde(rename = "generation")]
    _generation: u64,
}

pub(crate) fn decode_reply(bytes: &[u8]) -> ResolveAnswer {
    let parse = || -> Result<WireResolution, String> {
        let value: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
        if let Some(code) = value.get("code").and_then(serde_json::Value::as_str) {
            return Err(format!("module error: {code}"));
        }
        serde_json::from_value(value.get("result").unwrap_or(&value).clone())
            .map_err(|error| error.to_string())
    };
    match parse() {
        Ok(reply) if reply.via == "implicit" => ResolveAnswer::Implicit,
        Ok(reply)
            if matches!(
                reply.via.as_str(),
                "root" | "walk" | "containment" | "worktree"
            ) && is_project_pin(&reply.project_id) =>
        {
            ResolveAnswer::Registered {
                project_id: reply.project_id,
                canonical_root: reply.canonical_root,
                root_registered: reply.via == "root",
            }
        }
        Ok(reply) => {
            log_once(
                format!("entorhinal-value:{}:{}", reply.via, reply.project_id),
                "Ignoring an unsupported Entorhinal resolution",
            );
            ResolveAnswer::NotAnswering
        }
        Err(error) => {
            log_once(
                format!("entorhinal-decode:{error}"),
                "Ignoring an invalid Entorhinal reply",
            );
            ResolveAnswer::NotAnswering
        }
    }
}

#[cfg(test)]
pub(crate) async fn resolve_with_attempt(
    identities: &ProjectIdentityResolver,
    directory: &Path,
    attempt: impl Future<Output = ResolveAnswer>,
) -> Result<String, ProjectIdentityError> {
    resolve_with_store_attempt(identities, directory, None, attempt).await
}

/// The timeout covers the entire attempt, including connect and lazy route binding.
/// No writes occur inside the future: only a timely, accepted answer can authorize pins.
async fn resolve_with_store_attempt(
    identities: &ProjectIdentityResolver,
    directory: &Path,
    store: Option<&McStore>,
    attempt: impl Future<Output = ResolveAnswer>,
) -> Result<String, ProjectIdentityError> {
    let directory = match identities.eligible_directory(directory) {
        Ok(directory) => directory,
        // Inaccessible folders cannot authorize registered pins, but retain the
        // standalone resolver's legacy behavior (including its missing-path refusal).
        Err(_) => return identities.resolve(directory),
    };
    if let Some(pin) = identities.pinned_identity(&directory) {
        return Ok(pin);
    }
    let deadline = tokio::time::Instant::now() + DEADLINE;
    let answer = match tokio::time::timeout_at(deadline, attempt).await {
        Ok(answer) if tokio::time::Instant::now() < deadline => answer,
        _ => {
            log_once(
                "entorhinal-deadline".to_string(),
                "Entorhinal resolve deadline exceeded",
            );
            ResolveAnswer::NotAnswering
        }
    };
    match answer {
        ResolveAnswer::Registered {
            project_id,
            canonical_root,
            root_registered,
        } => {
            if let Some(store) = store {
                let fallback = identities.resolve(&directory)?;
                match store.is_authority_managed(&fallback) {
                    Ok(false) => {}
                    Ok(true) => {
                        log_once(
                            format!("entorhinal-rust-managed:{fallback}"),
                            &format!("Keeping Rust-managed project identity {fallback}; single-store migration required"),
                        );
                        return Ok(fallback);
                    }
                    Err(error) => {
                        // A failed authority read cannot authorize moving a project's data key.
                        log_once(
                            format!("entorhinal-authority-read:{fallback}"),
                            &format!("Keeping project identity {fallback}; authority check failed: {error}"),
                        );
                        return Ok(fallback);
                    }
                }
            }
            identities.pin_live_answer_with_root(
                &directory,
                &project_id,
                canonical_root.as_deref(),
                root_registered,
            );
            Ok(project_id)
        }
        ResolveAnswer::NotAnswering | ResolveAnswer::Implicit => {
            if let Some(pin) = identities.borrowed_identity(&directory) {
                return Ok(pin);
            }
            identities.resolve(&directory)
        }
        ResolveAnswer::Absent => identities.resolve(&directory),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use subc_control::{ClientControlRequest, ClientControlResponse};
    use subc_protocol::{ErrorBody, Flags, Frame, FrameType, Priority};
    use subc_transport::{
        authenticate_server, generate_daemon_id, generate_key, read_frame, write_atomic,
        write_frame, ConnectionInfo, Endpoint, SCHEMA_VERSION,
    };
    use tokio::net::TcpListener;

    enum Mode {
        Reply(Vec<u8>),
        ModuleError(String),
        NeverConnect,
        NeverReply,
        LateReply,
    }

    struct FakeEndpoint {
        connection_file: PathBuf,
        calls: Arc<Mutex<Vec<Value>>>,
        connections: Arc<AtomicUsize>,
        disconnect: Arc<AtomicBool>,
        task: tokio::task::JoinHandle<()>,
        _temp: tempfile::TempDir,
    }

    impl Drop for FakeEndpoint {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn fake_endpoint(mode: Mode, project: &Path) -> FakeEndpoint {
        let temp = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let key = generate_key().unwrap();
        let daemon_id = generate_daemon_id().unwrap();
        let connection_file = temp.path().join("connection.json");
        write_atomic(
            &connection_file,
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
                daemon_ver: "0.39.0".to_string(),
            },
        )
        .unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let log = calls.clone();
        let connections = Arc::new(AtomicUsize::new(0));
        let opened = connections.clone();
        let disconnect = Arc::new(AtomicBool::new(false));
        let disconnect_next = disconnect.clone();
        let project = project.to_path_buf();
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                if matches!(mode, Mode::NeverConnect) {
                    std::future::pending::<()>().await;
                }
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
                opened.fetch_add(1, Ordering::SeqCst);
                while let Ok(Some(frame)) = read_frame(&mut stream).await {
                    let (ty, body) = match frame.header.ty {
                        FrameType::Request if frame.header.channel == 0 => {
                            let control: ClientControlRequest =
                                serde_json::from_slice(&frame.body).unwrap();
                            if let ClientControlRequest::RouteOpen {
                                target, identity, ..
                            } = control
                            {
                                assert_eq!(target, route_target());
                                assert_eq!(identity.session, "instance");
                                let bind = serde_json::to_value(&identity).unwrap();
                                assert!(bind.get("project_root").is_none());
                                assert!(bind.get("project_id").is_none());
                                assert_eq!(identity.harness, "test-harness");
                                (
                                    FrameType::Response,
                                    serde_json::to_vec(&ClientControlResponse::RouteOpen {
                                        route_channel: 10,
                                        route_epoch: 1,
                                    })
                                    .unwrap(),
                                )
                            } else {
                                continue;
                            }
                        }
                        FrameType::Request => {
                            if disconnect_next.swap(false, Ordering::SeqCst) {
                                break;
                            }
                            let request: Value = serde_json::from_slice(&frame.body).unwrap();
                            assert_eq!(request["params"]["canonicalRoot"], json!(project));
                            log.lock().unwrap().push(request);
                            match &mode {
                            Mode::Reply(bytes) => (FrameType::Response, bytes.clone()),
                            Mode::ModuleError(code) => (FrameType::Error, serde_json::to_vec(&json!({ "code": code, "message": "fake error", "detail": null })).unwrap()),
                            Mode::NeverReply => { std::future::pending::<()>().await; unreachable!() }
                            Mode::LateReply => {
                                tokio::time::sleep(DEADLINE + Duration::from_millis(100)).await;
                                (FrameType::Response, root_reply(&project))
                            }
                            Mode::NeverConnect => unreachable!(),
                        }
                        }
                        _ => continue,
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
        FakeEndpoint {
            connection_file,
            calls,
            connections,
            disconnect,
            task,
            _temp: temp,
        }
    }

    #[tokio::test]
    async fn binds_share_a_process_consumer_and_reconnect_after_disconnect() {
        let temp = tempfile::tempdir().unwrap();
        let project = std::fs::canonicalize(temp.path()).unwrap();
        let fake = fake_endpoint(
            Mode::Reply(
                serde_json::to_vec(&json!({
                    "result": {"via": "implicit", "projectId": "pj-implicit1-test"}
                }))
                .unwrap(),
            ),
            &project,
        )
        .await;
        let identities = ProjectIdentityResolver::with_sidecar_dir(project.join("sidecars"));
        let expected = crate::project_identity::directory_fallback(&project);
        for _ in 0..8 {
            let resolver = EntorhinalResolver::new(Some(fake.connection_file.clone()));
            assert_eq!(
                resolver
                    .resolve_for_session(&identities, &project, "test-harness", "instance", None)
                    .await
                    .unwrap(),
                expected
            );
        }
        assert_eq!(fake.calls.lock().unwrap().len(), 8);
        assert_eq!(fake.connections.load(Ordering::SeqCst), 1);
        fake.disconnect.store(true, Ordering::SeqCst);
        let resolver = EntorhinalResolver::new(Some(fake.connection_file.clone()));
        assert_eq!(
            resolver
                .resolve_for_session(&identities, &project, "test-harness", "instance", None)
                .await
                .unwrap(),
            expected
        );
        assert_eq!(
            resolver
                .resolve_for_session(&identities, &project, "test-harness", "instance", None)
                .await
                .unwrap(),
            expected
        );
        assert_eq!(fake.calls.lock().unwrap().len(), 9);
        assert_eq!(fake.connections.load(Ordering::SeqCst), 2);
    }

    fn root_reply(directory: &Path) -> Vec<u8> {
        let mut vectors: Value = serde_json::from_str(include_str!(
            "../../../test-vectors/project-resolve-v1/resolve.json"
        ))
        .unwrap();
        vectors[0]["reply"]["result"]["canonicalRoot"] = json!(directory);
        serde_json::to_vec(&vectors[0]["reply"]).unwrap()
    }

    #[tokio::test]
    async fn management_surface_uses_the_callers_bind_and_pins_the_reply() {
        let temp = tempfile::tempdir().unwrap();
        let project = std::fs::canonicalize(temp.path()).unwrap();
        let fake = fake_endpoint(Mode::Reply(root_reply(&project)), &project).await;
        let identities = ProjectIdentityResolver::with_sidecar_dir(project.join("sidecars"));
        let resolver = EntorhinalResolver::new(Some(fake.connection_file.clone()));
        assert_eq!(
            resolver
                .resolve_for_session(&identities, &project, "test-harness", "instance", None)
                .await
                .unwrap(),
            "pj-resolve-root"
        );
        assert_eq!(
            *fake.calls.lock().unwrap(),
            vec![json!({ "method": "resolve", "params": { "canonicalRoot": project } })]
        );
        assert_eq!(
            identities.pinned_identity(&project).as_deref(),
            Some("pj-resolve-root")
        );
        // An existing pin returns without waiting for another connection attempt.
        let stalled = fake_endpoint(Mode::NeverConnect, &project).await;
        let resolver = EntorhinalResolver::new(Some(stalled.connection_file.clone()));
        assert_eq!(
            resolver
                .resolve_for_session(&identities, &project, "test-harness", "instance", None)
                .await
                .unwrap(),
            "pj-resolve-root"
        );
        assert!(stalled.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn only_unknown_module_is_absence() {
        for code in ["unknown_module", "storage_unavailable", "invalid_params"] {
            let body: ErrorBody = serde_json::from_value(
                json!({ "code": code, "message": "fake error", "detail": null }),
            )
            .unwrap();
            assert_eq!(
                classify_call_error(CallError::Module(body)),
                if code == "unknown_module" {
                    ResolveAnswer::Absent
                } else {
                    ResolveAnswer::NotAnswering
                }
            );
        }
    }

    async fn deadline_case(mode: Mode) {
        let temp = tempfile::tempdir().unwrap();
        let project = std::fs::canonicalize(temp.path()).unwrap();
        let sidecars = project.join("sidecars");
        let identities = ProjectIdentityResolver::with_sidecar_dir(sidecars.clone());
        let fake = fake_endpoint(mode, &project).await;
        let resolver = EntorhinalResolver::new(Some(fake.connection_file.clone()));
        let started = tokio::time::Instant::now();
        assert_eq!(
            resolver
                .resolve_for_session(&identities, &project, "test-harness", "instance", None)
                .await
                .unwrap(),
            crate::project_identity::directory_fallback(&project)
        );
        assert!(started.elapsed() >= Duration::from_millis(450));
        assert!(started.elapsed() < Duration::from_millis(900));
        assert!(!sidecars.exists());
        // Keep the endpoint alive past its delayed delivery before inspecting writes.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!sidecars.exists());
        assert!(identities.pinned_identity(&project).is_none());
    }

    #[tokio::test]
    async fn never_completing_connect_is_bounded() {
        deadline_case(Mode::NeverConnect).await;
    }
    #[tokio::test]
    async fn never_completing_reply_is_bounded() {
        deadline_case(Mode::NeverReply).await;
    }
    #[tokio::test]
    async fn late_reply_uses_fallback_and_writes_nothing() {
        deadline_case(Mode::LateReply).await;
    }

    #[tokio::test]
    async fn absent_errors_and_transport_failure_keep_the_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let project = std::fs::canonicalize(temp.path()).unwrap();
        let identities = ProjectIdentityResolver::with_sidecar_dir(project.join("sidecars"));
        let fallback = crate::project_identity::directory_fallback(&project);
        for path in [None, Some(project.join("missing-connection.json"))] {
            let resolver = EntorhinalResolver::new(path);
            assert_eq!(
                resolver
                    .resolve_for_session(&identities, &project, "test-harness", "instance", None)
                    .await
                    .unwrap(),
                fallback
            );
        }
        for code in ["unknown_module", "storage_unavailable", "invalid_params"] {
            let fake = fake_endpoint(Mode::ModuleError(code.to_string()), &project).await;
            let resolver = EntorhinalResolver::new(Some(fake.connection_file.clone()));
            assert_eq!(
                resolver
                    .resolve_for_session(&identities, &project, "test-harness", "instance", None)
                    .await
                    .unwrap(),
                fallback
            );
            assert_eq!(fake.calls.lock().unwrap().len(), 1);
        }
        let invalid_connection = project.join("invalid-connection.json");
        std::fs::write(&invalid_connection, b"not JSON").unwrap();
        let resolver = EntorhinalResolver::new(Some(invalid_connection));
        assert_eq!(
            resolver
                .resolve_for_session(&identities, &project, "test-harness", "instance", None)
                .await
                .unwrap(),
            fallback
        );
        assert!(identities.pinned_identity(&project).is_none());
    }

    #[tokio::test]
    async fn missing_directory_is_refused_before_contacting_the_endpoint() {
        let identities = ProjectIdentityResolver::new();
        let temp = tempfile::tempdir().unwrap();
        let polled = std::cell::Cell::new(false);
        let result = resolve_with_attempt(&identities, &temp.path().join("missing"), async {
            polled.set(true);
            ResolveAnswer::NotAnswering
        })
        .await;
        assert!(matches!(
            result,
            Err(ProjectIdentityError::Unreadable { .. })
        ));
        assert!(!polled.get());
    }
}
