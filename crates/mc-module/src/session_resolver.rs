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

/// Broca binds provider and tool routes as a runner, not as the caller's harness.
/// The caller's harness travels separately in compaction and hook request bodies.
pub const RUNNER_BIND_HARNESS: &str = "runner";

/// Provider callbacks use the configured runner route and the SDK's daemon-verified
/// module launch identity. They must never use the gateway's session resolver.
#[async_trait]
pub trait ProviderRunner: Send + Sync {
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
        let identity = BindIdentity::new(project_root.to_path_buf(), RUNNER_BIND_HARNESS, session);
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
                    identity.clone(),
                    serde_json::to_vec(&json!({"method": method, "params": params}))
                        .map_err(|e| SessionResolveError::Transport(e.to_string()))?,
                    CallOptions {
                        timeout: budget,
                        route_retry_deadline: budget,
                        ..call_options()
                    },
                )
                .await;
            consumer
                .close_route(target, identity, CloseRouteOptions::default())
                .await;
            consumer.close().await;
            let bytes = response.map_err(call_error_to_resolve_error)?;
            serde_json::from_slice(&bytes)
                .map_err(|e| SessionResolveError::InvalidResponse(e.to_string()))
        };
        tokio::time::timeout(budget, work)
            .await
            .map_err(|_| SessionResolveError::Timeout)?
    }
}

pub struct MissingProviderRunner;

#[async_trait]
impl ProviderRunner for MissingProviderRunner {
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
}

impl fmt::Display for SessionResolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Timeout => write!(f, "session.resolve timed out"),
            Self::Transport(message) => write!(f, "session.resolve transport failed: {message}"),
            Self::InvalidResponse(message) => {
                write!(f, "session.resolve returned an invalid response: {message}")
            }
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
        project_root: &Path,
        harness: &str,
        instance_token: &str,
    ) -> Result<Option<ResolvedSession>, SessionResolveError> {
        let target = self.route_target();
        let identity = BindIdentity::new(project_root.to_path_buf(), harness, instance_token);
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
}
