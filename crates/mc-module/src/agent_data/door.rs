//! Agent move transport. Stream ownership is determined by the daemon-attested
//! consumer principal; no door request carries a caller-chosen stream label.
use crate::route_targets::{RegisteredRoute, RouteTargetConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use subc_client_rs::{
    async_trait, CallError, CallOptions, CloseRouteOptions, ConsumerOptions, SubcConsumer,
};
use subc_protocol::BindIdentity;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub durable_offset: u64,
    pub cloud_offset: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadReply {
    pub bytes: String,
    pub from_offset: u64,
    pub end_offset: u64,
    pub stream_end: u64,
    #[serde(default)]
    pub digest: Option<String>,
}
#[derive(Debug, Clone)]
pub struct DoorError {
    pub code: String,
    pub detail: Option<Value>,
}
impl DoorError {
    pub fn unavailable() -> Self {
        Self {
            code: "unavailable".into(),
            detail: None,
        }
    }
}
#[async_trait]
pub trait EngramDoor: Send + Sync {
    async fn cover(&self, session_ref: &str) -> Result<Position, DoorError>;
    async fn admit(
        &self,
        session_ref: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<Position, DoorError>;
    async fn read(
        &self,
        session_ref: &str,
        offset: u64,
        limit: usize,
        cut: Option<&str>,
    ) -> Result<ReadReply, DoorError>;
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LookupSession {
    pub agent_id: String,
    pub ref_kind: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub harness: String,
    pub session_id: String,
    pub project_root: String,
    /// The bare module id of the runner hosting the session. Without it the
    /// reference cannot be checked, so the answer is treated as not found.
    #[serde(default)]
    pub runner: Option<String>,
}
#[async_trait]
pub trait SessionLookup: Send + Sync {
    async fn session_for_ref(
        &self,
        kind: &str,
        reference: &str,
    ) -> Result<Option<LookupSession>, DoorError>;
}

pub struct SubcMoveIo {
    connection_file: Option<PathBuf>,
    module_id: String,
}
impl SubcMoveIo {
    pub fn new(connection_file: Option<PathBuf>, module_id: String) -> Self {
        Self {
            connection_file,
            module_id,
        }
    }
    async fn call(
        &self,
        route: RegisteredRoute,
        method: &str,
        params: Value,
    ) -> Result<Value, DoorError> {
        let path = self
            .connection_file
            .as_ref()
            .ok_or_else(DoorError::unavailable)?;
        let target = RouteTargetConfig::default()
            .target(route)
            .ok_or_else(DoorError::unavailable)?;
        let identity = BindIdentity::new("agent-data", "agent-data");
        let budget = Duration::from_secs(30);
        let nonce = subc_client_rs::launch_nonce()
            .ok()
            .flatten()
            .ok_or_else(DoorError::unavailable)?;
        let consumer_identity = subc_control::ConsumerIdentity {
            module_id: self.module_id.clone(),
            launch_nonce: nonce.value().to_owned(),
        };
        let consumer = SubcConsumer::connect(path, ConsumerOptions::default())
            .await
            .map_err(|_| DoorError::unavailable())?;
        let response = consumer
            .call(
                target.clone(),
                identity.clone(),
                serde_json::to_vec(&json!({"method":method,"params":params}))
                    .expect("move request JSON"),
                CallOptions {
                    timeout: budget,
                    route_retry_deadline: budget,
                    consumer_identity: Some(consumer_identity.clone()),
                    ..CallOptions::default()
                },
            )
            .await;
        consumer
            .close_route(
                target,
                identity,
                CloseRouteOptions {
                    consumer_identity: Some(consumer_identity),
                    ..CloseRouteOptions::default()
                },
            )
            .await;
        consumer.close().await;
        let bytes = response.map_err(|error| match error {
            CallError::Module(body) => DoorError {
                code: body.code,
                detail: body.detail,
            },
            _ => DoorError::unavailable(),
        })?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| DoorError::unavailable())?;
        Ok(value.get("result").cloned().unwrap_or(value))
    }
}
#[async_trait]
impl EngramDoor for SubcMoveIo {
    async fn cover(&self, r: &str) -> Result<Position, DoorError> {
        serde_json::from_value(
            self.call(
                RegisteredRoute::EngramDoor,
                "session.cover",
                json!({"sessionRef":r}),
            )
            .await?,
        )
        .map_err(|_| DoorError::unavailable())
    }
    async fn admit(&self, r: &str, offset: u64, bytes: &[u8]) -> Result<Position, DoorError> {
        serde_json::from_value(
            self.call(
                RegisteredRoute::EngramDoor,
                "session.admit",
                json!({"sessionRef":r,"fromOffset":offset,"bytes":hex(bytes)}),
            )
            .await?,
        )
        .map_err(|_| DoorError::unavailable())
    }
    async fn read(
        &self,
        r: &str,
        offset: u64,
        limit: usize,
        cut: Option<&str>,
    ) -> Result<ReadReply, DoorError> {
        let mut params = json!({"sessionRef":r,"fromOffset":offset,"limit":limit});
        if let Some(cut) = cut {
            params["cutId"] = json!(cut);
        }
        serde_json::from_value(
            self.call(RegisteredRoute::EngramDoor, "session.read", params)
                .await?,
        )
        .map_err(|_| DoorError::unavailable())
    }
}
#[async_trait]
impl SessionLookup for SubcMoveIo {
    async fn session_for_ref(
        &self,
        kind: &str,
        r: &str,
    ) -> Result<Option<LookupSession>, DoorError> {
        match self
            .call(
                RegisteredRoute::EntorhinalSessionRef,
                "agent.session_for_ref",
                json!({"ref_kind":kind,"ref":r}),
            )
            .await
        {
            Ok(value) => serde_json::from_value(value)
                .map(Some)
                .map_err(|_| DoorError::unavailable()),
            Err(error) if error.code == "not_found" => Ok(None),
            Err(error) => Err(error),
        }
    }
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn unhex(text: &str) -> Result<Vec<u8>, DoorError> {
    if !text.len().is_multiple_of(2) {
        return Err(DoorError::unavailable());
    }
    text.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let digit = |b: u8| match b {
                b'0'..=b'9' => Some(b - b'0'),
                b'a'..=b'f' => Some(b - b'a' + 10),
                b'A'..=b'F' => Some(b - b'A' + 10),
                _ => None,
            };
            Ok(digit(pair[0]).ok_or_else(DoorError::unavailable)? * 16
                + digit(pair[1]).ok_or_else(DoorError::unavailable)?)
        })
        .collect()
}
