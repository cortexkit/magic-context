//! The production `BrocaPort`: llm-runner/v1 ops of one dream child carried over
//! subc routes to the configured runner module.
//!
//! Each op goes to the runner's management surface (the same target the historian
//! uses, `RegisteredRoute::HistorianRunner`) on a route bound to the child's Broca
//! session, with the `{method, params}` envelope Broca serves. `next_unit` follows
//! the session's `session.subscribe` stream from its start. `release` closes the
//! routes and never deletes anything; the carrier asks the runner to delete a
//! child with the `session.release` op before that, when the runner declares
//! `session_retention`.
//!
//! For a runner-lane conversation the same ops go to that conversation's own runner
//! instead ([`SessionRunnerRoute`]). Each child route stays bound to its child
//! session; the parent relationship is used to validate the task scope, not sent in
//! a field the runner does not declare.

use super::broca_carrier::{BrocaPort, PortError};
use super::executor::BrocaPorts;
use crate::route_targets::{RegisteredRoute, RouteTargetConfig, SessionRunnerRoute};
use crate::session_resolver::llm_runner_role_versions;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
use subc_client_rs::{
    CallError, CallOptions, CloseRouteOptions, ConsumerOptions, SubcConsumer, SubscribeOptions,
    Subscription,
};
use subc_protocol::{BindIdentity, RouteTarget};

/// One op's deadline. A Broca op answers at once; model work is followed on the
/// subscription, never awaited inside a unary op.
const OP_TIMEOUT: Duration = Duration::from_secs(30);

/// How to reach the configured Broca runner from this process.
#[derive(Clone)]
pub struct SubcBroca {
    pub connection_file: PathBuf,
    pub route_targets: RouteTargetConfig,
    pub project_root: PathBuf,
    pub harness: String,
    /// When set, children go to this conversation's own runner, not the configured one.
    pub session_runner: Option<SessionRunnerRoute>,
    pub child_scopes: std::sync::Arc<crate::child_scopes::ChildScopes>,
}

impl SubcBroca {
    /// The runner target, or `None` when no background-completion route to a
    /// runner module is declared for this process.
    pub fn target(route_targets: &RouteTargetConfig) -> Option<RouteTarget> {
        route_targets.target(RegisteredRoute::HistorianRunner)
    }
}

impl BrocaPorts for SubcBroca {
    type Port = SubcBrocaPort;
    fn port(&self) -> SubcBrocaPort {
        SubcBrocaPort {
            config: self.clone(),
            consumer: None,
            subscription: None,
            routes: std::collections::HashMap::new(),
        }
    }
}

pub struct SubcBrocaPort {
    config: SubcBroca,
    consumer: Option<SubcConsumer>,
    subscription: Option<(String, Subscription)>,
    routes: std::collections::HashMap<String, subc_client_rs::RouteHandle>,
}

fn port_error(code: &str, message: impl Into<String>, outcome_unknown: bool) -> PortError {
    PortError {
        code: code.into(),
        message: message.into(),
        detail: Value::Null,
        outcome_unknown,
    }
}

/// A module refusal is a definite answer: the op had no effect. Anything else
/// (a timeout, a dropped connection) may have reached the runner first.
fn call_error(error: CallError) -> PortError {
    match error {
        CallError::Module(body) => PortError {
            code: body.code.clone(),
            message: body.message.clone(),
            // The refusal's own detail (for example the frozen policy of a
            // `retention_conflict`) rides along when the module sent one.
            detail: match &body.detail {
                Some(detail) => {
                    json!({"code": body.code, "message": body.message, "detail": detail})
                }
                None => json!({"code": body.code, "message": body.message}),
            },
            outcome_unknown: false,
        },
        other => port_error("transport", other.to_string(), true),
    }
}

impl SubcBrocaPort {
    async fn consumer(&mut self) -> Result<&SubcConsumer, PortError> {
        if self.consumer.is_none() {
            let options = ConsumerOptions {
                handshake_timeout: OP_TIMEOUT,
                call_timeout: OP_TIMEOUT,
                ..ConsumerOptions::default()
            };
            let consumer = SubcConsumer::connect(&self.config.connection_file, options)
                .await
                .map_err(|e| port_error("transport", e.to_string(), false))?;
            self.consumer = Some(consumer);
        }
        Ok(self.consumer.as_ref().expect("consumer was just connected"))
    }

    fn route(&self, session: &str) -> Result<(RouteTarget, BindIdentity), PortError> {
        let target = match &self.config.session_runner {
            Some(route) => route.target(),
            None => SubcBroca::target(&self.config.route_targets)
                .ok_or_else(|| port_error("broca_unwired", "no runner route is declared", false))?,
        };
        Ok((
            target,
            BindIdentity::new(self.config.harness.clone(), session),
        ))
    }

    async fn route_handle(
        &mut self,
        session: &str,
    ) -> Result<subc_client_rs::RouteHandle, PortError> {
        let (target, identity) = self.route(session)?;
        let scope = self
            .config
            .child_scopes
            .for_project(&self.config.project_root)
            .await
            .map_err(|error| port_error(&error.code, error.message, false))?;
        let handle = self
            .consumer()
            .await?
            .open_route_scoped(
                target,
                identity,
                scope,
                CallOptions {
                    timeout: OP_TIMEOUT,
                    route_retry_deadline: OP_TIMEOUT,
                    role_versions: Some(llm_runner_role_versions()),
                    ..CallOptions::default()
                },
            )
            .await
            .map_err(call_error)?;
        self.routes.insert(session.to_owned(), handle);
        Ok(handle)
    }
}

impl BrocaPort for SubcBrocaPort {
    async fn call(&mut self, session: &str, op: &str, params: Value) -> Result<Value, PortError> {
        let handle = self.route_handle(session).await?;
        let body = serde_json::to_vec(&json!({"method": op, "params": params}))
            .map_err(|e| port_error("invalid_params", e.to_string(), false))?;
        let consumer = self.consumer().await?;
        let bytes = consumer
            .request(
                &handle,
                body,
                CallOptions {
                    timeout: OP_TIMEOUT,
                    route_retry_deadline: OP_TIMEOUT,
                    role_versions: Some(llm_runner_role_versions()),
                    ..CallOptions::default()
                },
            )
            .await
            .map_err(call_error)?;
        serde_json::from_slice(&bytes)
            .map_err(|e| port_error("invalid_response", e.to_string(), true))
    }

    async fn next_unit(&mut self, session: &str) -> Result<Option<Value>, PortError> {
        if self
            .subscription
            .as_ref()
            .is_none_or(|(subscribed, _)| subscribed != session)
        {
            let handle = self.route_handle(session).await?;
            let body = serde_json::to_vec(
                &json!({"method": "session.subscribe", "params": {"from": "start"}}),
            )
            .map_err(|e| port_error("invalid_params", e.to_string(), false))?;
            let consumer = self.consumer().await?;
            let subscription = consumer
                .subscribe_route(
                    &handle,
                    body,
                    SubscribeOptions {
                        route_open_timeout: OP_TIMEOUT,
                        route_retry_deadline: OP_TIMEOUT,
                        role_versions: Some(llm_runner_role_versions()),
                        ..SubscribeOptions::default()
                    },
                )
                .await
                .map_err(call_error)?;
            self.subscription = Some((session.to_owned(), subscription));
        }
        let (_, subscription) = self.subscription.as_mut().expect("subscribed above");
        match subscription.events().try_recv() {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| port_error("invalid_unit", e.to_string(), false)),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => Ok(None),
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                self.subscription = None;
                Err(port_error(
                    "subscription_closed",
                    "the session stream closed",
                    false,
                ))
            }
        }
    }

    async fn release(&mut self, session: &str) {
        if let Some((_, subscription)) = self.subscription.take() {
            let _ = subscription.unsubscribe();
        }
        if let (Some(handle), Some(consumer)) = (self.routes.remove(session), &self.consumer) {
            let _ = consumer
                .close_handle(
                    &handle,
                    CloseRouteOptions {
                        role_versions: Some(llm_runner_role_versions()),
                        ..CloseRouteOptions::default()
                    },
                )
                .await;
        }
    }

    fn session_runner_parent(&self) -> Option<&str> {
        self.config
            .session_runner
            .as_ref()
            .map(SessionRunnerRoute::parent_session)
    }
}

impl Drop for SubcBrocaPort {
    fn drop(&mut self) {
        if let Some((_, subscription)) = self.subscription.take() {
            let _ = subscription.unsubscribe();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_runner_child_uses_recorded_root_and_harness_with_child_session() {
        let root = PathBuf::from("/canonical/project");
        let principal = subc_protocol::Principal::Reserved {
            module_id: "broca".into(),
        };
        let runner = SubcBroca {
            child_scopes: crate::child_scopes::test_service(),
            connection_file: PathBuf::new(),
            route_targets: RouteTargetConfig::default(),
            project_root: root.clone(),
            harness: "claude-code".into(),
            session_runner: Some(
                SessionRunnerRoute::for_principal(Some(&principal), "conversation").unwrap(),
            ),
        };

        let (target, identity) = runner.port().route("dream-child").unwrap();

        assert_eq!(
            target,
            RouteTarget::ManagementSurface {
                module_id: "broca".into()
            }
        );
        assert!(serde_json::to_value(&identity)
            .unwrap()
            .get("project_root")
            .is_none());
        assert_eq!(identity.harness, "claude-code");
        assert_eq!(identity.session, "dream-child");
    }
}
