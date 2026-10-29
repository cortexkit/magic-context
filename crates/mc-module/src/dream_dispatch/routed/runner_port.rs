//! The runner's unary calls and follow stream share one scoped, session-bound route.

use super::{production::connect, wire::RunnerBind};
use crate::dream_dispatch::broca_carrier::PortError;
use serde_json::{json, Value};
use std::path::PathBuf;
use subc_client_rs::{
    CallError, CallOptions, CloseRouteOptions, RouteHandle, SubcConsumer, SubscribeOptions,
    Subscription,
};
use subc_protocol::{scope::ScopeSelector, BindIdentity};

pub(super) struct RunnerPort {
    connection: PathBuf,
    scope: ScopeSelector,
    root: PathBuf,
    bind: RunnerBind,
    consumer: Option<SubcConsumer>,
    route: Option<RouteHandle>,
    subscription: Option<Subscription>,
}

fn error(code: &str, message: impl Into<String>, outcome_unknown: bool) -> PortError {
    PortError {
        code: code.into(),
        message: message.into(),
        detail: Value::Null,
        outcome_unknown,
    }
}

fn call_error(e: CallError) -> PortError {
    match e {
        CallError::Module(body) => PortError {
            code: body.code.clone(),
            message: body.message.clone(),
            detail: serde_json::to_value(body).unwrap_or(Value::Null),
            outcome_unknown: false,
        },
        other => error("transport", other.to_string(), true),
    }
}

impl RunnerPort {
    pub fn new(connection: PathBuf, scope: ScopeSelector, root: PathBuf, bind: RunnerBind) -> Self {
        Self {
            connection,
            scope,
            root,
            bind,
            consumer: None,
            route: None,
            subscription: None,
        }
    }

    async fn open(&mut self) -> Result<(), PortError> {
        if self.route.is_some() {
            return Ok(());
        }
        let consumer = connect(&self.connection)
            .await
            .map_err(|e| error("transport", e, false))?;
        let route = consumer
            .open_route_scoped(
                crate::route_targets::routed_module_target(&self.bind.module),
                BindIdentity::new(
                    self.root.clone(),
                    self.bind.harness.clone(),
                    self.bind.session.clone(),
                ),
                self.scope.clone(),
                CallOptions {
                    role_versions: Some(crate::session_resolver::llm_runner_role_versions()),
                    ..CallOptions::default()
                },
            )
            .await
            .map_err(call_error)?;
        self.consumer = Some(consumer);
        self.route = Some(route);
        Ok(())
    }

    pub async fn call(&mut self, op: &str, params: Value) -> Result<Value, PortError> {
        self.open().await?;
        let bytes = self
            .consumer
            .as_ref()
            .expect("open consumer")
            .request(
                &self.route.expect("open route"),
                serde_json::to_vec(&json!({"method": op, "params": params})).expect("runner JSON"),
                CallOptions {
                    role_versions: Some(crate::session_resolver::llm_runner_role_versions()),
                    ..CallOptions::default()
                },
            )
            .await
            .map_err(call_error)?;
        serde_json::from_slice(&bytes).map_err(|e| error("invalid_response", e.to_string(), true))
    }

    pub async fn next(&mut self) -> Result<Option<Value>, PortError> {
        self.open().await?;
        if self.subscription.is_none() {
            let stream = self
                .consumer
                .as_ref()
                .expect("open consumer")
                .subscribe_route(
                    &self.route.expect("open route"),
                    serde_json::to_vec(
                        &json!({"method": "session.subscribe", "params": {"from": "start"}}),
                    )
                    .expect("subscribe JSON"),
                    SubscribeOptions {
                        role_versions: Some(crate::session_resolver::llm_runner_role_versions()),
                        ..SubscribeOptions::default()
                    },
                )
                .await
                .map_err(call_error)?;
            self.subscription = Some(stream);
        }
        match self
            .subscription
            .as_mut()
            .expect("subscribed")
            .events()
            .try_recv()
        {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| error("invalid_unit", e.to_string(), false)),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => Ok(None),
            Err(_) => Err(error(
                "subscription_closed",
                "runner follow stream closed",
                false,
            )),
        }
    }

    pub async fn close(&mut self) {
        if let Some(stream) = self.subscription.take() {
            let _ = stream.unsubscribe();
        }
        if let Some(consumer) = self.consumer.take() {
            if let Some(route) = self.route.take() {
                let _ = consumer
                    .close_handle(&route, CloseRouteOptions::default())
                    .await;
            }
            consumer.close().await;
        }
    }
}
