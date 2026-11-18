//! Sealing and opening messages with the vault's fleet epoch key.
//!
//! ck-mc never holds the key. The vault (claustrum) seals and opens for it
//! on its management surface, under ck-mc's attested principal
//! (`reserved:magic-context`), which selects the Magic Context domain of the
//! key's additional data. The wire shape is the vault's fleet epoch
//! contract (claustrum `docs/wire-contract-v1.md`, fleet epoch operations):
//! `fleet.epoch_seal_batch {items: [{aad, plaintext}]}` answers
//! `{items: [{epoch, nonce, ciphertext}]}`, and `fleet.epoch_open_batch
//! {items: [{epoch, nonce, ciphertext, aad}]}` answers a plaintext or an
//! `{error: {code, class}}` per item. Bytes are unpadded base64url; a batch
//! holds 1 to 256 items.
//!
//! Plaintext is memory content: it is held in buffers wiped when dropped,
//! and no error, log line or `Debug` output carries it.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use subc_client_rs::CallOptions;
use subc_protocol::{BindIdentity, RouteTarget};
use zeroize::Zeroizing;

use super::wire::{decode, encode};

/// The most items one batch call may carry.
pub const MAX_BATCH: usize = 256;

/// How long one vault call may take.
const VAULT_CALL_TIMEOUT: Duration = Duration::from_secs(10);

/// The vault's module id.
const VAULT_MODULE: &str = "claustrum";

/// One message to seal.
pub struct SealInput {
    pub aad: Vec<u8>,
    pub plaintext: Zeroizing<Vec<u8>>,
}

/// The vault's seal of one message, as its wire gives it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sealed {
    pub epoch: u64,
    pub nonce: String,
    pub ciphertext: String,
}

/// One message to open.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenInput {
    pub epoch: u64,
    pub nonce: String,
    pub ciphertext: String,
    pub aad: Vec<u8>,
}

/// What opening one message gave.
pub enum Opened {
    Plaintext(Zeroizing<Vec<u8>>),
    /// The vault would not open this item (a wrong key, a tampered
    /// message, an unknown epoch); the other items are unaffected.
    Refused {
        code: String,
        class: String,
    },
}

impl std::fmt::Debug for Opened {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Plaintext(bytes) => write!(f, "Plaintext({} bytes)", bytes.len()),
            Self::Refused { code, class } => write!(f, "Refused({code}, {class})"),
        }
    }
}

/// A whole call failed: nothing was sealed or opened. `transient` failures
/// (the vault not reachable, no current epoch yet) are retried later.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealError {
    pub code: String,
    pub transient: bool,
}

impl std::fmt::Display for SealError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.code)
    }
}

impl SealError {
    fn transient(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            transient: true,
        }
    }

    fn permanent(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            transient: false,
        }
    }
}

/// The sealing ck-mc's messages go through.
#[async_trait]
pub trait Sealer: Send + Sync {
    /// Seal every item, in order, under the current epoch.
    async fn seal_batch(&self, items: &[SealInput]) -> Result<Vec<Sealed>, SealError>;
    /// Open every item, in order.
    async fn open_batch(&self, items: &[OpenInput]) -> Result<Vec<Opened>, SealError>;
}

/// `fleet.epoch_seal_batch`'s parameters.
pub fn seal_batch_params(items: &[SealInput]) -> Value {
    json!({
        "items": items
            .iter()
            .map(|item| json!({"aad": encode(&item.aad), "plaintext": encode(&item.plaintext)}))
            .collect::<Vec<_>>(),
    })
}

/// `fleet.epoch_open_batch`'s parameters.
pub fn open_batch_params(items: &[OpenInput]) -> Value {
    json!({
        "items": items
            .iter()
            .map(|item| json!({
                "aad": encode(&item.aad),
                "ciphertext": item.ciphertext,
                "epoch": item.epoch,
                "nonce": item.nonce,
            }))
            .collect::<Vec<_>>(),
    })
}

/// The refusal a whole-call error body carries, if `value` is one.
fn refusal(value: &Value) -> Option<SealError> {
    let error = value.get("error")?;
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("vault_error")
        .to_owned();
    let transient = error.get("class").and_then(Value::as_str) == Some("transient");
    Some(SealError { code, transient })
}

/// The items of a batch reply, which must hold one per request item.
fn reply_items(value: &Value, expected: usize) -> Result<&Vec<Value>, SealError> {
    let result = value.get("result").unwrap_or(value);
    if let Some(error) = refusal(result) {
        return Err(error);
    }
    let items = result
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| SealError::permanent("vault_reply_invalid"))?;
    if items.len() != expected {
        return Err(SealError::permanent("vault_reply_count"));
    }
    Ok(items)
}

/// Read `fleet.epoch_seal_batch`'s reply for `expected` items.
pub fn parse_seal_reply(value: &Value, expected: usize) -> Result<Vec<Sealed>, SealError> {
    reply_items(value, expected)?
        .iter()
        .map(|item| {
            let text = |key: &str| {
                item.get(key)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| SealError::permanent("vault_reply_invalid"))
            };
            Ok(Sealed {
                epoch: item
                    .get("epoch")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| SealError::permanent("vault_reply_invalid"))?,
                nonce: text("nonce")?,
                ciphertext: text("ciphertext")?,
            })
        })
        .collect()
}

/// Read `fleet.epoch_open_batch`'s reply for `expected` items.
pub fn parse_open_reply(value: &Value, expected: usize) -> Result<Vec<Opened>, SealError> {
    reply_items(value, expected)?
        .iter()
        .map(|item| {
            if let Some(error) = item.get("error") {
                return Ok(Opened::Refused {
                    code: error
                        .get("code")
                        .and_then(Value::as_str)
                        .unwrap_or("vault_error")
                        .to_owned(),
                    class: error
                        .get("class")
                        .and_then(Value::as_str)
                        .unwrap_or("permanent")
                        .to_owned(),
                });
            }
            let plaintext = item
                .get("plaintext")
                .and_then(Value::as_str)
                .ok_or_else(|| SealError::permanent("vault_reply_invalid"))?;
            decode(plaintext)
                .map(|bytes| Opened::Plaintext(Zeroizing::new(bytes)))
                .map_err(|_| SealError::permanent("vault_reply_invalid"))
        })
        .collect()
}

/// The vault, called on its management surface over ck-mc's own SDK
/// consumer.
pub struct Claustrum {
    consumer: crate::transport::SharedConsumer,
}

impl Claustrum {
    pub fn over(consumer: crate::transport::SharedConsumer) -> Arc<Self> {
        Arc::new(Self { consumer })
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, SealError> {
        let consumer = self
            .consumer
            .get()
            .await
            .map_err(|_| SealError::transient("vault_connect"))?;
        // The request holds plaintext, so its buffer is wiped once sent.
        let body = Zeroizing::new(
            serde_json::to_vec(&json!({"method": method, "params": params}))
                .map_err(|_| SealError::permanent("vault_request_encode"))?,
        );
        let reply = consumer
            .call(
                RouteTarget::ManagementSurface {
                    module_id: VAULT_MODULE.into(),
                },
                BindIdentity::new(crate::MODULE_ID, "replica"),
                body.to_vec(),
                CallOptions {
                    timeout: VAULT_CALL_TIMEOUT,
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| SealError::transient(error.code().unwrap_or("vault_call")))?;
        let reply = Zeroizing::new(reply);
        serde_json::from_slice(&reply).map_err(|_| SealError::permanent("vault_reply_invalid"))
    }
}

#[async_trait]
impl Sealer for Claustrum {
    async fn seal_batch(&self, items: &[SealInput]) -> Result<Vec<Sealed>, SealError> {
        let reply = self
            .call("fleet.epoch_seal_batch", seal_batch_params(items))
            .await?;
        parse_seal_reply(&reply, items.len())
    }

    async fn open_batch(&self, items: &[OpenInput]) -> Result<Vec<Opened>, SealError> {
        let reply = self
            .call("fleet.epoch_open_batch", open_batch_params(items))
            .await?;
        parse_open_reply(&reply, items.len())
    }
}
