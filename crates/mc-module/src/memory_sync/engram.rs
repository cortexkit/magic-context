//! Engram's device-stream service: the account's per-device op streams that
//! new memories are appended to.

use std::future::Future;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::client::RunnerClient;

#[derive(Clone, Debug)]
pub(super) struct Heads {
    pub account: String,
    pub device: String,
    /// The last sequence number this device's stream holds.
    pub head: i64,
}

pub(super) trait Engram: Send + Sync {
    fn heads(&self) -> impl Future<Output = Result<Heads, String>> + Send;
    /// Append one op at `seq`; the answer is the stream's new last sequence.
    fn append(&self, seq: i64, bytes: &[u8]) -> impl Future<Output = Result<i64, String>> + Send;
}

/// Engram reached through ck-mc's daemon connection.
pub(super) struct Wire<'a, C>(pub &'a C);

impl<C: RunnerClient> Engram for Wire<'_, C> {
    async fn heads(&self) -> Result<Heads, String> {
        decode_heads(&self.0.engram_call("stream.heads", json!({})).await?)
    }

    async fn append(&self, seq: i64, bytes: &[u8]) -> Result<i64, String> {
        if bytes.is_empty() || bytes.len() > super::op::OP_CAP {
            return Err("too_large".into());
        }
        self.0
            .engram_call("stream.append", append_request(seq, bytes))
            .await?["seq_end"]
            .as_i64()
            .ok_or("malformed_reply".into())
    }
}

/// `stream.heads`: the account, this device, and every device's stream.
#[derive(Deserialize)]
struct HeadsReply {
    account: String,
    device: String,
    devices: Vec<DeviceStream>,
}

#[derive(Deserialize)]
struct DeviceStream {
    device: String,
    /// Whether the stream is this device's own.
    #[serde(rename = "self", default)]
    own: bool,
    head: i64,
}

pub(super) fn decode_heads(value: &Value) -> Result<Heads, String> {
    let malformed = || "malformed_reply".to_owned();
    let reply: HeadsReply = serde_json::from_value(value.clone()).map_err(|_| malformed())?;
    let hex = |text: &str| {
        text.len() == 32
            && text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if !hex(&reply.account) || !hex(&reply.device) {
        return Err(malformed());
    }
    let own: Vec<&DeviceStream> = reply.devices.iter().filter(|stream| stream.own).collect();
    let [stream] = own.as_slice() else {
        return Err(malformed());
    };
    if stream.device != reply.device || stream.head < 0 {
        return Err(malformed());
    }
    Ok(Heads {
        head: stream.head,
        account: reply.account,
        device: reply.device,
    })
}

/// An append carries the op's canonical bytes, hex-encoded.
pub(super) fn append_request(seq: i64, bytes: &[u8]) -> Value {
    let entry: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    json!({"seq": seq, "entries": [entry]})
}
