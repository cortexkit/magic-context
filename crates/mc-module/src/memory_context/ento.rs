use std::future::Future;
use std::path::PathBuf;
use std::time::Duration;

use cortexkit_agent_identity::{ContextProjectParams, ContextSessionParams};
use cortexkit_project_identity::{Outcome, Request};
use serde::Serialize;
use serde_json::Value;
use subc_client_rs::{
    CallError, CallOptions, CloseRouteOptions, ConsumerOptions, RetryBackoff, SubcConsumer,
};
use subc_protocol::BindIdentity;

use super::{ContextAnswer, ContextReply, ProjectContext, SessionContext};
use crate::entorhinal_resolve::{consumer_slot, route_target, ConsumerLease};

const DEADLINE: Duration = Duration::from_millis(500);

pub(crate) struct MemoryContextReader {
    connection_file: Option<PathBuf>,
    identity: BindIdentity,
}

impl MemoryContextReader {
    pub fn new(connection_file: Option<PathBuf>, identity: BindIdentity) -> Self {
        Self {
            connection_file,
            identity,
        }
    }

    pub async fn project(&self, folder: &str) -> ContextAnswer<ProjectContext> {
        self.read(Request::new(
            "context.project",
            ContextProjectParams::new(folder.to_owned()),
        ))
        .await
    }

    pub async fn session(&self, agent_id: &str) -> ContextAnswer<SessionContext> {
        self.read(Request::new(
            "context.session",
            ContextSessionParams::new(agent_id.to_owned()),
        ))
        .await
    }

    async fn read<T: ContextReply, P: Serialize>(&self, request: Request<P>) -> ContextAnswer<T> {
        let request = serde_json::to_vec(&request).expect("context request is JSON");
        within_deadline(self.attempt(request)).await
    }

    async fn attempt<T: ContextReply>(&self, request: Vec<u8>) -> ContextAnswer<T> {
        let Some(file) = self.connection_file.as_deref().filter(|file| file.exists()) else {
            return ContextAnswer::NotAnswering;
        };
        let slot = consumer_slot(file);
        // Resolve and context reads serialize on the same process-scoped consumer.
        // The outer deadline includes waiting for this lock, connect and cleanup.
        let mut cached = slot.lock().await;
        let consumer = if let Some(consumer) = cached.take() {
            consumer
        } else {
            match SubcConsumer::connect(
                file,
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
                Err(_) => return ContextAnswer::NotAnswering,
            }
        };
        let mut lease = ConsumerLease(Some(consumer));
        let consumer = lease.0.as_ref().unwrap();
        let response = consumer
            .call(
                route_target(),
                self.identity.clone(),
                request,
                CallOptions {
                    timeout: DEADLINE,
                    route_retry: retry_backoff(),
                    route_retry_deadline: DEADLINE,
                    ..CallOptions::default()
                },
            )
            .await;
        if response.is_ok() || matches!(&response, Err(CallError::Module(_))) {
            consumer
                .close_route(
                    route_target(),
                    self.identity.clone(),
                    CloseRouteOptions::default(),
                )
                .await;
            *cached = lease.0.take();
        }
        match response {
            Ok(bytes) => decode_reply(&bytes),
            Err(CallError::Module(body))
                if !matches!(body.code.as_str(), "unknown_module" | "unknown_method") =>
            {
                ContextAnswer::Refused {
                    code: serde_json::from_value(Value::String(body.code))
                        .expect("refusal codes include unknown strings"),
                    message: body.message,
                    detail: body.detail.unwrap_or(serde_json::Value::Null),
                }
            }
            Err(_) => ContextAnswer::NotAnswering,
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

pub(super) async fn within_deadline<T>(
    attempt: impl Future<Output = ContextAnswer<T>>,
) -> ContextAnswer<T> {
    tokio::time::timeout(DEADLINE, attempt)
        .await
        .unwrap_or(ContextAnswer::NotAnswering)
}

pub(super) fn decode_reply<T: ContextReply>(bytes: &[u8]) -> ContextAnswer<T> {
    let (Ok(raw), Ok(outcome)) = (
        serde_json::from_slice::<Value>(bytes),
        serde_json::from_slice::<Outcome<T>>(bytes),
    ) else {
        return ContextAnswer::NotAnswering;
    };
    match outcome {
        Outcome::Success(success)
            if raw.as_object().is_some_and(|object| object.len() == 1)
                && success.result.valid_for_context()
                && serde_json::to_value(&success.result).ok().as_ref() == raw.get("result") =>
        {
            ContextAnswer::Answer(success.result)
        }
        Outcome::Refusal(refusal)
            if raw.as_object().is_some_and(|object| {
                object.contains_key("code")
                    && object.contains_key("message")
                    && object
                        .keys()
                        .all(|key| matches!(key.as_str(), "code" | "message" | "detail"))
            }) && !matches!(
                raw.get("code").and_then(Value::as_str),
                Some("unknown_module" | "unknown_method")
            ) =>
        {
            ContextAnswer::Refused {
                code: refusal.code,
                message: refusal.message,
                detail: refusal.detail.unwrap_or(Value::Null),
            }
        }
        _ => ContextAnswer::NotAnswering,
    }
}
