//! Resolves Claude Code MCP facade instance tokens to the opaque conversation key.
//!
//! The MCP shim binds its route with a per-launch instance token, while the parent
//! conversation key is what names that Claude Code conversation's compartments. The
//! resolver is the only place that crosses that boundary: handlers pass the token as a
//! lookup argument, then use the returned key for conversation-scoped reads and as the
//! source session recorded on memory writes.

use std::{error::Error, fmt, path::Path, path::PathBuf, time::Duration};

use serde_json::{json, Value};
use subc_client_rs::{
    async_trait, CallError, CallOptions, CloseRouteOptions, ConsumerOptions, RetryBackoff,
    SubcConsumer,
};
use subc_protocol::{BindIdentity, RouteTarget};

use crate::route_targets::{RegisteredRoute, RouteTargetConfig};
const SESSION_RESOLVE_DEADLINE: Duration = Duration::from_secs(2);

/// Tool-provider and process-configured runner routes use the fixed `runner` harness.
/// Conversation routes for compaction use the route project root and the harness and
/// session reported in Setup.
pub const RUNNER_BIND_HARNESS: &str = "runner";

/// The bind identity for a conversation consists of the canonical project root from
/// the route that accepted Setup and the harness and session in Setup's body.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RunnerBindIdentity {
    pub project_root: PathBuf,
    pub harness: String,
    pub session: String,
}

/// The role versions every route this module opens to a runner declares:
/// it speaks `llm-runner/v1` there. The declaration is part of the route's
/// identity, so the same map must be given when the route is closed.
pub fn llm_runner_role_versions() -> std::collections::BTreeMap<String, String> {
    std::collections::BTreeMap::from([(
        cortexkit_role_llm_runner::ROLE.to_string(),
        cortexkit_role_llm_runner::VERSION.to_string(),
    )])
}

/// Provider callbacks use the configured runner route and the SDK's daemon-verified
/// module launch identity. They must never use the gateway's session resolver.
#[async_trait]
pub trait ProviderRunner: Send + Sync {
    async fn call_for(
        &self,
        route: &crate::route_targets::SessionRunnerRoute,
        project_root: &Path,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        self.call(project_root, route.parent_session(), method, params, budget)
            .await
    }
    async fn call_for_identity(
        &self,
        route: &crate::route_targets::SessionRunnerRoute,
        identity: &RunnerBindIdentity,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError>;
    async fn call(
        &self,
        project_root: &Path,
        session: &str,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError>;
}

pub struct RealProviderRunner {
    connection_file: PathBuf,
    route_targets: RouteTargetConfig,
}

impl RealProviderRunner {
    pub fn new(connection_file: PathBuf, route_targets: RouteTargetConfig) -> Self {
        Self {
            connection_file,
            route_targets,
        }
    }
}

#[async_trait]
impl ProviderRunner for RealProviderRunner {
    async fn call_for(
        &self,
        route: &crate::route_targets::SessionRunnerRoute,
        project_root: &Path,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        self.call_target(
            route.target(),
            &RunnerBindIdentity {
                project_root: project_root.to_path_buf(),
                harness: RUNNER_BIND_HARNESS.into(),
                session: route.parent_session().into(),
            },
            method,
            params,
            budget,
        )
        .await
    }

    async fn call_for_identity(
        &self,
        route: &crate::route_targets::SessionRunnerRoute,
        identity: &RunnerBindIdentity,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        if identity.session != route.parent_session() {
            return Err(SessionResolveError::InvalidResponse(
                "session runner route identity mismatch".into(),
            ));
        }
        self.call_target(route.target(), identity, method, params, budget)
            .await
    }
    async fn call(
        &self,
        project_root: &Path,
        session: &str,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        let target = self
            .route_targets
            .target(RegisteredRoute::ProviderRunner)
            .expect("provider runner has a registered target");
        self.call_target(
            target,
            &RunnerBindIdentity {
                project_root: project_root.to_path_buf(),
                harness: RUNNER_BIND_HARNESS.into(),
                session: session.into(),
            },
            method,
            params,
            budget,
        )
        .await
    }
}

impl RealProviderRunner {
    async fn call_target(
        &self,
        target: RouteTarget,
        identity: &RunnerBindIdentity,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        let bind_identity = BindIdentity::new(identity.harness.as_str(), identity.session.as_str());
        let work = async {
            let mut options = consumer_options();
            options.handshake_timeout = budget;
            options.call_timeout = budget;
            let consumer = SubcConsumer::connect(&self.connection_file, options)
                .await
                .map_err(|e| SessionResolveError::Transport(e.to_string()))?;
            let response = consumer
                .call(
                    target.clone(),
                    bind_identity.clone(),
                    serde_json::to_vec(&json!({"method": method, "params": params}))
                        .map_err(|e| SessionResolveError::Transport(e.to_string()))?,
                    CallOptions {
                        timeout: budget,
                        route_retry_deadline: budget,
                        role_versions: Some(llm_runner_role_versions()),
                        ..call_options()
                    },
                )
                .await;
            consumer
                .close_route(
                    target,
                    bind_identity,
                    CloseRouteOptions {
                        role_versions: Some(llm_runner_role_versions()),
                        ..CloseRouteOptions::default()
                    },
                )
                .await;
            consumer.close().await;
            let bytes = response.map_err(runner_call_error)?;
            let reply = serde_json::from_slice(&bytes)
                .map_err(|e| SessionResolveError::InvalidResponse(e.to_string()))?;
            read_runner_reply(reply)
        };
        tokio::time::timeout(budget, work)
            .await
            .map_err(|_| SessionResolveError::Timeout)?
    }
}

pub struct MissingProviderRunner;

#[async_trait]
impl ProviderRunner for MissingProviderRunner {
    async fn call_for_identity(
        &self,
        _: &crate::route_targets::SessionRunnerRoute,
        _: &RunnerBindIdentity,
        _: &str,
        _: Value,
        _: Duration,
    ) -> Result<Value, SessionResolveError> {
        Err(SessionResolveError::Transport(
            "provider runner connection is unavailable".into(),
        ))
    }

    async fn call(
        &self,
        _: &Path,
        _: &str,
        _: &str,
        _: Value,
        _: Duration,
    ) -> Result<Value, SessionResolveError> {
        Err(SessionResolveError::Transport(
            "provider runner connection is unavailable".into(),
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSession {
    /// Opaque composite conversation key returned by the thalamus gateway. Callers must not parse it;
    /// the instance token is only the lookup input.
    pub session_id: String,
    pub last_traffic_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionResolveError {
    Timeout,
    Transport(String),
    InvalidResponse(String),
    /// An llm-runner reply that is not exactly `{"result": <answer>}`; the
    /// detail names what arrived. See [`read_runner_reply`].
    ReplyShape(String),
    /// The runner refused the call with an ERROR frame: its role `code`.
    Refused {
        code: String,
        message: String,
    },
}

impl fmt::Display for SessionResolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Timeout => write!(f, "session.resolve timed out"),
            Self::Transport(message) => write!(f, "session.resolve transport failed: {message}"),
            Self::InvalidResponse(message) => {
                write!(f, "session.resolve returned an invalid response: {message}")
            }
            Self::ReplyShape(detail) => write!(
                f,
                "{RUNNER_REPLY_SHAPE}: llm-runner requires a reply of exactly {{\"result\": <answer>}}; {detail}"
            ),
            Self::Refused { code, message } => write!(f, "runner refused {code}: {message}"),
        }
    }
}

impl Error for SessionResolveError {}

#[async_trait]
pub trait SessionResolver: Send + Sync {
    async fn resolve_session(
        &self,
        project_root: &Path,
        harness: &str,
        instance_token: &str,
    ) -> Result<Option<ResolvedSession>, SessionResolveError>;
}

pub struct RealSessionResolver {
    connection_file: PathBuf,
    route_targets: RouteTargetConfig,
}

impl RealSessionResolver {
    pub fn new(connection_file: PathBuf) -> Self {
        Self::new_with_route_targets(connection_file, RouteTargetConfig::default())
    }

    pub fn new_with_route_targets(
        connection_file: PathBuf,
        route_targets: RouteTargetConfig,
    ) -> Self {
        Self {
            connection_file,
            route_targets,
        }
    }

    /// The management route this resolver opens. Split out so a local test can
    /// pin the runtime target's exact module id: the gateway registers as
    /// "thalamus", and a stale id here kills every stateful facade tool call
    /// at route-open.
    fn route_target(&self) -> RouteTarget {
        self.route_targets
            .target(RegisteredRoute::SessionResolve)
            .expect("session.resolve always has a registered module target")
    }

    async fn resolve_once(
        &self,
        _project_root: &Path,
        harness: &str,
        instance_token: &str,
    ) -> Result<Option<ResolvedSession>, SessionResolveError> {
        let target = self.route_target();
        let identity = BindIdentity::new(harness, instance_token);
        let consumer = SubcConsumer::connect(&self.connection_file, consumer_options())
            .await
            .map_err(|error| SessionResolveError::Transport(error.to_string()))?;
        let response = consumer
            .call(
                target.clone(),
                identity.clone(),
                serde_json::to_vec(&json!({
                    "method": "session.resolve",
                    "params": { "instance_token": instance_token }
                }))
                .map_err(|error| SessionResolveError::Transport(error.to_string()))?,
                call_options(),
            )
            .await;
        consumer
            .close_route(target, identity, CloseRouteOptions::default())
            .await;
        consumer.close().await;
        let response = response.map_err(call_error_to_resolve_error)?;
        let value: Value = serde_json::from_slice(&response).map_err(|error| {
            SessionResolveError::InvalidResponse(format!("response was not JSON: {error}"))
        })?;
        parse_resolve_response(&value)
    }
}

#[async_trait]
impl SessionResolver for RealSessionResolver {
    async fn resolve_session(
        &self,
        project_root: &Path,
        harness: &str,
        instance_token: &str,
    ) -> Result<Option<ResolvedSession>, SessionResolveError> {
        match tokio::time::timeout(
            SESSION_RESOLVE_DEADLINE,
            self.resolve_once(project_root, harness, instance_token),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(SessionResolveError::Timeout),
        }
    }
}

pub struct MissingSessionResolver;

#[async_trait]
impl SessionResolver for MissingSessionResolver {
    async fn resolve_session(
        &self,
        _project_root: &Path,
        _harness: &str,
        _instance_token: &str,
    ) -> Result<Option<ResolvedSession>, SessionResolveError> {
        Err(SessionResolveError::Transport(
            "mc-module was started without a subc connection file".to_string(),
        ))
    }
}

fn consumer_options() -> ConsumerOptions {
    ConsumerOptions {
        handshake_timeout: SESSION_RESOLVE_DEADLINE,
        // Channel-0 calls share the resolve deadline: session.resolve is the only
        // call this consumer makes, and a facade tool call must fail fast rather
        // than outlive its MCP request.
        call_timeout: SESSION_RESOLVE_DEADLINE,
        reconnect_backoff: RetryBackoff {
            base: Duration::from_millis(25),
            cap: Duration::from_millis(50),
            max_attempts: 1,
        },
        restored_debounce: Duration::from_millis(10),
        // Post-deadline liveness probe: keep the library default. This consumer's
        // calls fail fast on their own deadline above; the probe window only
        // shapes how quickly a silent half-open socket is declared dead.
        liveness_probe_window: ConsumerOptions::default().liveness_probe_window,
    }
}

fn call_options() -> CallOptions {
    CallOptions {
        timeout: SESSION_RESOLVE_DEADLINE,
        route_retry: RetryBackoff {
            base: Duration::from_millis(25),
            cap: Duration::from_millis(50),
            max_attempts: 1,
        },
        route_retry_deadline: SESSION_RESOLVE_DEADLINE,
        ..CallOptions::default()
    }
}

/// The contract error for an llm-runner reply in any shape but
/// `{"result": <answer>}`.
pub const RUNNER_REPLY_SHAPE: &str = "runner_reply_shape";

/// The answer inside an llm-runner reply. Every llm-runner op reply ck-mc
/// reads is exactly `{"result": <answer>}`, an object with that one key
/// (pinned for llm-runner 0.4.1). A bare answer, or a `result` beside other
/// keys, is refused by name rather than read either way, so a runner that
/// drifts from the pinned shape is seen at once instead of being misread.
/// This is the one place ck-mc decodes the runner reply envelope.
pub fn read_runner_reply(reply: Value) -> Result<Value, SessionResolveError> {
    match reply {
        Value::Object(mut map) if map.len() == 1 && map.contains_key("result") => {
            Ok(map.remove("result").expect("checked result key"))
        }
        Value::Object(map) => Err(SessionResolveError::ReplyShape(format!(
            "got an object with keys {:?}",
            map.keys().collect::<Vec<_>>()
        ))),
        other => Err(SessionResolveError::ReplyShape(format!(
            "got a JSON {}",
            match other {
                Value::Null => "null",
                Value::Bool(_) => "boolean",
                Value::Number(_) => "number",
                Value::String(_) => "string",
                Value::Array(_) => "array",
                Value::Object(_) => unreachable!(),
            }
        ))),
    }
}

/// A runner call's failure: an ERROR frame keeps the runner's own code, so
/// a caller can act on a named refusal (`fork_unsupported`, say).
fn runner_call_error(error: CallError) -> SessionResolveError {
    match error {
        CallError::Module(body) => SessionResolveError::Refused {
            code: body.code,
            message: body.message,
        },
        other => SessionResolveError::Transport(other.to_string()),
    }
}

fn call_error_to_resolve_error(error: CallError) -> SessionResolveError {
    match error {
        CallError::Module(body) if body.code == "session_resolve_timeout" => {
            SessionResolveError::Timeout
        }
        other => SessionResolveError::Transport(other.to_string()),
    }
}

fn parse_resolve_response(value: &Value) -> Result<Option<ResolvedSession>, SessionResolveError> {
    let payload = value.get("result").unwrap_or(value);
    match payload.get("session_id") {
        Some(Value::Null) | None => Ok(None),
        Some(Value::String(session_id)) => {
            let last_traffic_ms = payload
                .get("last_traffic_ms")
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    SessionResolveError::InvalidResponse(
                        "resolved session omitted integer last_traffic_ms".to_string(),
                    )
                })?;
            Ok(Some(ResolvedSession {
                session_id: session_id.clone(),
                last_traffic_ms,
            }))
        }
        Some(other) => Err(SessionResolveError::InvalidResponse(format!(
            "session_id must be string or null, got {other}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_direct_or_json_rpc_result_and_null_unresolved() {
        assert_eq!(
            parse_resolve_response(&json!({"session_id": "conv:key", "last_traffic_ms": 7}))
                .unwrap(),
            Some(ResolvedSession {
                session_id: "conv:key".to_string(),
                last_traffic_ms: 7,
            })
        );
        assert_eq!(
            parse_resolve_response(
                &json!({"result": {"session_id": "conv:2", "last_traffic_ms": 9}})
            )
            .unwrap(),
            Some(ResolvedSession {
                session_id: "conv:2".to_string(),
                last_traffic_ms: 9,
            })
        );
        assert_eq!(
            parse_resolve_response(&json!({"session_id": null})).unwrap(),
            None
        );
    }

    #[test]
    fn real_resolver_routes_to_the_thalamus_management_surface() {
        let resolver = RealSessionResolver::new(PathBuf::from("/nonexistent"));
        // Pin the exact runtime module id: the gateway registers as "thalamus";
        // any other id (e.g. the retired "ai-proxy") fails every facade call.
        assert_eq!(
            format!("{:?}", resolver.route_target()),
            "ManagementSurface { module_id: \"thalamus\" }"
        );
    }

    /// What a fake daemon saw of one runner route.open request.
    #[derive(Debug, Default)]
    struct SeenRoute {
        target: Option<RouteTarget>,
        identity: Value,
        harness: String,
        session: String,
        role_versions: Option<std::collections::BTreeMap<String, String>>,
    }

    /// A one-connection fake daemon answering every routed request with `{}`.
    async fn fake_daemon() -> (
        tempfile::TempDir,
        PathBuf,
        std::sync::Arc<std::sync::Mutex<Vec<SeenRoute>>>,
    ) {
        fake_daemon_answering(br#"{"result":{}}"#.to_vec()).await
    }

    /// A daemon whose every routed request is answered with `reply`.
    async fn fake_daemon_answering(
        reply: Vec<u8>,
    ) -> (
        tempfile::TempDir,
        PathBuf,
        std::sync::Arc<std::sync::Mutex<Vec<SeenRoute>>>,
    ) {
        fake_daemon_answering_frame(reply, subc_protocol::FrameType::Response).await
    }

    async fn fake_daemon_answering_frame(
        reply: Vec<u8>,
        reply_type: subc_protocol::FrameType,
    ) -> (
        tempfile::TempDir,
        PathBuf,
        std::sync::Arc<std::sync::Mutex<Vec<SeenRoute>>>,
    ) {
        use subc_control::{ClientControlRequest, ClientControlResponse};
        use subc_protocol::{Flags, Frame, FrameType, Priority};
        use subc_transport::{
            authenticate_server, generate_daemon_id, generate_key, read_frame, write_atomic,
            write_frame, ConnectionInfo, Endpoint, SCHEMA_VERSION,
        };
        let temp = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
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
                daemon_ver: "0.39.0".into(),
            },
        )
        .unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<SeenRoute>::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                authenticate_server(
                    &mut stream,
                    &key,
                    &daemon_id,
                    "fake",
                    Duration::from_secs(2),
                )
                .await
                .unwrap();
                while let Ok(Some(frame)) = read_frame(&mut stream).await {
                    let body = match frame.header.ty {
                        FrameType::Request if frame.header.channel == 0 => {
                            let Ok(ClientControlRequest::RouteOpen {
                                target,
                                identity,
                                role_versions,
                                ..
                            }) = serde_json::from_slice(&frame.body)
                            else {
                                continue;
                            };
                            let mut log = log.lock().unwrap();
                            log.push(SeenRoute {
                                target: Some(target),
                                identity: serde_json::to_value(&identity).unwrap(),
                                harness: identity.harness,
                                session: identity.session,
                                role_versions,
                            });
                            serde_json::to_vec(&ClientControlResponse::RouteOpen {
                                route_channel: 9 + log.len() as u16,
                                route_epoch: 1,
                            })
                            .unwrap()
                        }
                        FrameType::Request => reply.clone(),
                        _ => continue,
                    };
                    let response = Frame::build(
                        if frame.header.channel == 0 {
                            FrameType::Response
                        } else {
                            reply_type
                        },
                        Flags::new(false, Priority::Interactive, false),
                        frame.header.channel,
                        frame.header.epoch,
                        frame.header.corr,
                        body,
                    )
                    .unwrap();
                    write_frame(&mut stream, &response).await.unwrap();
                }
            }
        });
        (temp, connection_file, seen)
    }

    /// The one place ck-mc decodes an llm-runner reply: exactly
    /// `{"result": <answer>}`. A bare answer and a `result` beside other keys
    /// are both refused by name, never read either way.
    #[test]
    fn runner_replies_are_read_only_in_the_pinned_wrapped_shape() {
        let page = json!({"lineage_id":"L","messages":[]});
        assert_eq!(
            read_runner_reply(json!({"result": page.clone()})).unwrap(),
            page
        );
        let refused = |reply: Value| match read_runner_reply(reply.clone()) {
            Err(error @ SessionResolveError::ReplyShape(_)) => {
                assert!(error.to_string().starts_with(RUNNER_REPLY_SHAPE), "{error}");
            }
            other => panic!("{reply} was not refused by shape: {other:?}"),
        };
        refused(page.clone());
        refused(json!({"result": page.clone(), "lineage_id": "L"}));
        refused(json!({"result": page, "error": null}));
        refused(json!({}));
        refused(json!(null));
        refused(json!([{"result": {}}]));
    }

    /// Through the real runner client: a wrapped `session.read` page and a
    /// wrapped `session.send` reply come back as their answers; a bare page
    /// is refused by name.
    #[tokio::test]
    async fn the_runner_client_reads_wrapped_replies_and_refuses_bare_ones() {
        let route = crate::route_targets::SessionRunnerRoute::for_principal(
            Some(&subc_protocol::Principal::Reserved {
                module_id: "broca".into(),
            }),
            "s",
        )
        .unwrap();
        let identity = RunnerBindIdentity {
            project_root: "/project".into(),
            harness: "broca".into(),
            session: "s".into(),
        };
        let page = json!({"lineage_id":"L","messages":[]});
        let send = json!({"state":"pending","submission_id":"q"});
        for (reply, method, expected) in [
            (
                json!({"result": page.clone()}),
                "session.read",
                Some(page.clone()),
            ),
            (
                json!({"result": send.clone()}),
                "session.send",
                Some(send.clone()),
            ),
            (page.clone(), "session.read", None),
        ] {
            let (_temp, connection_file, _) =
                fake_daemon_answering(serde_json::to_vec(&reply).unwrap()).await;
            let runner =
                RealProviderRunner::new(connection_file, RouteTargetConfig::runner_module("broca"));
            let answer = runner
                .call_for_identity(&route, &identity, method, json!({}), Duration::from_secs(5))
                .await;
            match (answer, expected) {
                (Ok(answer), Some(expected)) => assert_eq!(answer, expected),
                (Err(SessionResolveError::ReplyShape(_)), None) => {}
                (other, expected) => panic!("{method} {reply}: {other:?}, expected {expected:?}"),
            }
        }
    }

    #[tokio::test]
    async fn broca_session_change_plan_model_mismatch_keeps_the_named_refusal() {
        let bytes = crate::broca_session_change_tests::sample_bytes(
            "session.refresh.plan_model_mismatch.json",
        );
        let (_temp, connection_file, _) =
            fake_daemon_answering_frame(bytes, subc_protocol::FrameType::Error).await;
        let runner =
            RealProviderRunner::new(connection_file, RouteTargetConfig::runner_module("broca"));
        let error = runner
            .call(
                std::path::Path::new("/project"),
                "s",
                "session.refresh",
                json!({}),
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();
        match error {
            SessionResolveError::Refused { code, message } => {
                assert_eq!(code, "plan_model_mismatch");
                assert_eq!(message, "pending refresh generation 1: provider fixture has a plan model different from the send model");
            }
            other => panic!("expected a named refusal, got {other:?}"),
        }
    }

    /// Both runner paths, the process-configured provider runner and a
    /// conversation's own session runner, open their route declaring
    /// `llm-runner/v1`.
    #[tokio::test]
    async fn every_provider_runner_route_declares_llm_runner_v1() {
        let (_temp, connection_file, seen) = fake_daemon().await;
        let runner =
            RealProviderRunner::new(connection_file, RouteTargetConfig::runner_module("broca"));
        let project = Path::new("/project");
        runner
            .call(
                project,
                "s",
                "session.read",
                json!({}),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        let route = crate::route_targets::SessionRunnerRoute::for_principal(
            Some(&subc_protocol::Principal::Reserved {
                module_id: "thalamus-harness".into(),
            }),
            "parent",
        )
        .unwrap();
        runner
            .call_for_identity(
                &route,
                &RunnerBindIdentity {
                    project_root: project.to_path_buf(),
                    harness: "claude-code".into(),
                    session: "parent".into(),
                },
                "session.read",
                json!({}),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert!(seen[0].identity.get("project_root").is_none());
        assert_eq!(seen[0].harness, RUNNER_BIND_HARNESS);
        assert_eq!(seen[0].session, "s");
        assert!(seen[1].identity.get("project_root").is_none());
        assert_eq!(seen[1].harness, "claude-code");
        assert_eq!(seen[1].session, "parent");
        let expected = Some(std::collections::BTreeMap::from([(
            "llm-runner".to_string(),
            "v1".to_string(),
        )]));
        for (route, module) in seen.iter().zip(["broca", "thalamus-harness"]) {
            assert_eq!(
                route.target,
                Some(RouteTarget::ManagementSurface {
                    module_id: module.into()
                })
            );
            assert_eq!(route.role_versions, expected, "{route:?}");
        }
        assert_eq!(seen[1].session, "parent");
    }
}
