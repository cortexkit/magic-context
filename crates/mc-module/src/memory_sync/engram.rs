//! Device-stream transport, separate from the session.cover/admit/read move API.
#[derive(Clone, Debug)]
pub(super) struct Heads {
    pub account: String,
    pub device: String,
    pub head: i64,
}

pub(super) trait Engram: Send + Sync {
    async fn heads(&self) -> Result<Heads, String>;
    async fn append(&self, seq: i64, bytes: &[u8]) -> Result<i64, String>;
}

#[derive(Clone)]
pub(super) struct Wire {
    pub file: std::path::PathBuf,
    pub module_id: String,
}

impl Wire {
    async fn call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        use subc_client_rs::{
            CallError, CallOptions, CloseRouteOptions, ConsumerOptions, SubcConsumer,
        };
        let budget = std::time::Duration::from_secs(5);
        let nonce = subc_client_rs::launch_nonce()
            .ok()
            .flatten()
            .ok_or("unavailable")?;
        let caller = subc_control::ConsumerIdentity {
            module_id: self.module_id.clone(),
            launch_nonce: nonce.value().to_owned(),
        };
        let identity = subc_protocol::BindIdentity::new(
            std::path::PathBuf::from("/"),
            "memory-sync",
            "memory-sync",
        );
        let target = crate::route_targets::RouteTargetConfig::default()
            .target(crate::route_targets::RegisteredRoute::EngramDeviceStreams)
            .expect("device-streams route");
        let attempt = async {
            let consumer = SubcConsumer::connect(
                &self.file,
                ConsumerOptions {
                    handshake_timeout: budget,
                    call_timeout: budget,
                    ..ConsumerOptions::default()
                },
            )
            .await
            .map_err(|_| "unavailable".to_owned())?;
            let response = consumer
                .call(
                    target.clone(),
                    identity.clone(),
                    serde_json::to_vec(&serde_json::json!({"method":method,"params":params}))
                        .unwrap(),
                    CallOptions {
                        timeout: budget,
                        route_retry_deadline: std::time::Duration::from_millis(500),
                        consumer_identity: Some(caller.clone()),
                        ..CallOptions::default()
                    },
                )
                .await;
            consumer
                .close_route(
                    target,
                    identity,
                    CloseRouteOptions {
                        consumer_identity: Some(caller),
                        ..CloseRouteOptions::default()
                    },
                )
                .await;
            consumer.close().await;
            let bytes = response.map_err(|e| match e {
                CallError::Module(body) => body.code,
                _ => "unavailable".into(),
            })?;
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| "malformed_reply".to_owned())?;
            if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
                return Err(error.to_owned());
            }
            Ok(value)
        };
        tokio::time::timeout(budget, attempt)
            .await
            .map_err(|_| "timeout".to_owned())?
    }
}

pub(super) fn decode_heads(value: &serde_json::Value) -> Result<Heads, String> {
    let hex = |v: Option<&str>| {
        v.filter(|s| {
            s.len() == 32
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .map(str::to_owned)
        .ok_or("malformed_reply".to_owned())
    };
    let account = hex(value["account"].as_str())?;
    let device = hex(value["device"].as_str())?;
    let devices = value["devices"].as_array().ok_or("malformed_reply")?;
    let rows: Vec<_> = devices
        .iter()
        .filter(|row| row["self"].as_bool() == Some(true))
        .collect();
    if rows.len() != 1 || rows[0]["device"].as_str() != Some(&device) {
        return Err("malformed_reply".into());
    }
    let head = rows[0]["head"]
        .as_i64()
        .filter(|n| *n >= 0)
        .ok_or("malformed_reply")?;
    Ok(Heads {
        account,
        device,
        head,
    })
}

pub(super) fn append_request(seq: i64, bytes: &[u8]) -> serde_json::Value {
    serde_json::json!({"seq":seq,"entries":[crate::digest::hex(bytes)]})
}

impl Engram for Wire {
    async fn heads(&self) -> Result<Heads, String> {
        decode_heads(&self.call("stream.heads", serde_json::json!({})).await?)
    }
    async fn append(&self, seq: i64, bytes: &[u8]) -> Result<i64, String> {
        if bytes.is_empty() || bytes.len() > super::op::OP_CAP {
            return Err("too_large".into());
        }
        self.call("stream.append", append_request(seq, bytes))
            .await?["seq_end"]
            .as_i64()
            .ok_or("malformed_reply".into())
    }
}
