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
//! [`Claustrum`] makes those calls with the claustrum client's typed fleet
//! epoch methods, over ck-mc's own SDK consumer. Each call is one attempt,
//! with no retry inside the client: a seal sent twice would give a second
//! ciphertext, and the engine seals again on its next round anyway. The
//! tests also build and read the wire shape by hand (the functions marked
//! for tests below), to check it against the vault's published samples;
//! ck-mc itself never does.
//!
//! Plaintext is memory content: it is held in buffers wiped when dropped,
//! and no error, log line or `Debug` output carries it. The client keeps it
//! in its own wiped buffers on the way to the vault and back; the copies
//! inside the SDK's request bodies and frames are the SDK's.

use std::sync::Arc;

use async_trait::async_trait;
use cortexkit_claustrum_client::{
    ClaustrumCredentialResolver, CredentialErrorClass, CredentialResolverError,
    FleetEpochOpenRequest, FleetEpochOpenResult, FleetEpochSeal, FleetEpochSealRequest, Secret,
};
#[cfg(test)]
use serde_json::{json, Value};
#[cfg(test)]
use zeroize::Zeroize;
use zeroize::Zeroizing;

use super::wire::{decode, encode};

/// The most items one batch call may carry.
pub const MAX_BATCH: usize = 256;

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

/// `fleet.epoch_seal_batch`'s parameters, built by hand.
#[cfg(test)]
pub(crate) fn seal_batch_params(items: &[SealInput]) -> Value {
    json!({
        "items": items
            .iter()
            .map(|item| json!({"aad": encode(&item.aad), "plaintext": encode(&item.plaintext)}))
            .collect::<Vec<_>>(),
    })
}

/// `fleet.epoch_open_batch`'s parameters, built by hand.
#[cfg(test)]
pub(crate) fn open_batch_params(items: &[OpenInput]) -> Value {
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

/// Overwrite every `plaintext` text in a vault request or reply built or
/// read with the functions above, once it is no longer needed.
#[cfg(test)]
pub(crate) fn wipe_plaintexts(value: &mut Value) {
    match value {
        Value::Object(members) => {
            for (key, member) in members.iter_mut() {
                match member {
                    Value::String(text) if key == "plaintext" => text.zeroize(),
                    other => wipe_plaintexts(other),
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(wipe_plaintexts),
        _ => {}
    }
}

/// The refusal a whole-call error body carries, if `value` is one.
#[cfg(test)]
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
#[cfg(test)]
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

/// Read `fleet.epoch_seal_batch`'s reply for `expected` items by hand.
#[cfg(test)]
pub(crate) fn parse_seal_reply(value: &Value, expected: usize) -> Result<Vec<Sealed>, SealError> {
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

/// Read `fleet.epoch_open_batch`'s reply for `expected` items by hand.
#[cfg(test)]
pub(crate) fn parse_open_reply(value: &Value, expected: usize) -> Result<Vec<Opened>, SealError> {
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

/// The vault, called with the claustrum client's typed fleet epoch calls
/// over ck-mc's own SDK consumer.
pub struct Claustrum {
    consumer: crate::transport::SharedConsumer,
    resolver: tokio::sync::OnceCell<ClaustrumCredentialResolver>,
}

impl Claustrum {
    pub fn over(consumer: crate::transport::SharedConsumer) -> Arc<Self> {
        Arc::new(Self {
            consumer,
            resolver: tokio::sync::OnceCell::new(),
        })
    }

    /// The client, made on first use over the shared consumer.
    async fn resolver(&self) -> Result<&ClaustrumCredentialResolver, SealError> {
        self.resolver
            .get_or_try_init(|| async {
                let consumer = self
                    .consumer
                    .get()
                    .await
                    .map_err(|_| SealError::transient("vault_connect"))?;
                Ok(ClaustrumCredentialResolver::with_consumer(Arc::clone(
                    consumer,
                )))
            })
            .await
    }
}

/// A whole call's failure: transient when the vault couldn't be reached or
/// answered that it may work later.
pub(crate) fn call_error(error: &CredentialResolverError) -> SealError {
    SealError {
        code: error.code().to_owned(),
        transient: error.retryable() || error.is_transport(),
    }
}

/// A seal as the envelope carries it, its bytes in unpadded base64url.
pub(crate) fn sealed(seal: FleetEpochSeal) -> Sealed {
    Sealed {
        epoch: u64::from(seal.epoch),
        nonce: encode(&seal.nonce),
        ciphertext: encode(&seal.ciphertext),
    }
}

/// The bytes the vault opens for one envelope.
pub(crate) struct OpenBytes {
    epoch: u32,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

/// `item`'s bytes, or `None` when its envelope can't hold anything the
/// vault sealed: a nonce or ciphertext that isn't unpadded base64url, or
/// an epoch beyond the vault's numbering.
pub(crate) fn open_bytes(item: &OpenInput) -> Option<OpenBytes> {
    Some(OpenBytes {
        epoch: u32::try_from(item.epoch).ok()?,
        nonce: decode(&item.nonce).ok()?,
        ciphertext: decode(&item.ciphertext).ok()?,
    })
}

/// The refusal of an envelope that can never open ([`open_bytes`]),
/// decided without asking the vault.
pub(crate) const ENVELOPE_INVALID: &str = "fleet_epoch_envelope_invalid";

/// The vault's class of a refusal, as [`Opened::Refused`] names it.
fn class_name(class: CredentialErrorClass) -> &'static str {
    match class {
        CredentialErrorClass::Permanent => "permanent",
        CredentialErrorClass::Transient => "transient",
        other => other.classifier_code(),
    }
}

/// Each item's outcome, in order: refused here when it had no bytes to
/// send, otherwise the vault's answer, the answers being in the order the
/// items with bytes were sent.
pub(crate) fn merge(
    bytes: &[Option<OpenBytes>],
    answers: Vec<FleetEpochOpenResult>,
) -> Result<Vec<Opened>, SealError> {
    let mut answers = answers.into_iter();
    let opened = bytes
        .iter()
        .map(|bytes| {
            if bytes.is_none() {
                return Ok(Opened::Refused {
                    code: ENVELOPE_INVALID.to_owned(),
                    class: "permanent".to_owned(),
                });
            }
            match answers.next() {
                Some(Ok(plaintext)) => Ok(Opened::Plaintext(Zeroizing::new(
                    plaintext.expose().clone(),
                ))),
                Some(Err(refusal)) => Ok(Opened::Refused {
                    code: refusal.code().to_owned(),
                    class: class_name(refusal.class).to_owned(),
                }),
                None => Err(SealError::permanent("vault_reply_count")),
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    if answers.next().is_some() {
        return Err(SealError::permanent("vault_reply_count"));
    }
    Ok(opened)
}

#[async_trait]
impl Sealer for Claustrum {
    async fn seal_batch(&self, items: &[SealInput]) -> Result<Vec<Sealed>, SealError> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        // Each plaintext in a buffer of the client's, wiped when dropped.
        let plaintexts: Vec<Secret<Vec<u8>>> = items
            .iter()
            .map(|item| Secret::new(item.plaintext.to_vec()))
            .collect();
        let requests: Vec<FleetEpochSealRequest<'_>> = items
            .iter()
            .zip(&plaintexts)
            .map(|(item, plaintext)| FleetEpochSealRequest {
                aad: &item.aad,
                plaintext,
            })
            .collect();
        let seals = self
            .resolver()
            .await?
            .fleet_epoch_seal_batch(&requests)
            .await
            .map_err(|error| call_error(&error))?;
        if seals.len() != items.len() {
            return Err(SealError::permanent("vault_reply_count"));
        }
        Ok(seals.into_iter().map(sealed).collect())
    }

    async fn open_batch(&self, items: &[OpenInput]) -> Result<Vec<Opened>, SealError> {
        let bytes: Vec<Option<OpenBytes>> = items.iter().map(open_bytes).collect();
        let requests: Vec<FleetEpochOpenRequest<'_>> = items
            .iter()
            .zip(&bytes)
            .filter_map(|(item, bytes)| {
                let bytes = bytes.as_ref()?;
                Some(FleetEpochOpenRequest {
                    epoch: bytes.epoch,
                    nonce: &bytes.nonce,
                    ciphertext: &bytes.ciphertext,
                    aad: &item.aad,
                })
            })
            .collect();
        let answers = if requests.is_empty() {
            Vec::new()
        } else {
            self.resolver()
                .await?
                .fleet_epoch_open_batch(&requests)
                .await
                .map_err(|error| call_error(&error))?
        };
        merge(&bytes, answers)
    }
}
