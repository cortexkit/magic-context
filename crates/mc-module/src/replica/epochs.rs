//! Which fleet epochs exist, and what a vault refusal to open a message
//! means for the stream.
//!
//! A message is sealed under the fleet epoch current on the computer that
//! sent it. A computer whose vault doesn't hold that epoch yet (a newly
//! paired one, or one the hub's wrap of a new epoch hasn't reached) can't
//! open it now but will later, so such a message is never skipped for good:
//! the engine holds its position before it and reads it again
//! ([`super::apply`]). Only a message the vault can never open is skipped.
//!
//! [`unopened`] decides which, in one place. It reads the vault's refusal
//! code and the hub's epoch record as Entorhinal reports it
//! ([`FleetEpochs`], `fleet.epoch_current`): `current`, the hub's current
//! epoch as this computer last saw it, and `highest_held`, the highest
//! epoch this computer's vault holds. Either may be unknown. When a member
//! changes, Entorhinal bumps its `fleet_epoch` marker, and the replica task
//! reads a held message again at once ([`super::live`]).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

/// The hub's epoch record as this computer sees it. `None` is unknown.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EpochStatus {
    /// The hub's current epoch, as this computer's cached view has it. It
    /// may lag a rotation another computer just made.
    pub current: Option<u64>,
    /// The highest epoch this computer's vault holds.
    pub highest_held: Option<u64>,
}

/// Where the engine reads the epoch record from.
#[async_trait]
pub trait FleetEpochs: Send + Sync {
    /// The record now. A source that can't answer gives unknown members.
    async fn status(&self) -> EpochStatus;
}

/// A source that knows nothing: every member unknown.
pub struct UnknownEpochs;

#[async_trait]
impl FleetEpochs for UnknownEpochs {
    async fn status(&self) -> EpochStatus {
        EpochStatus::default()
    }
}

/// Entorhinal's operation that answers the epoch record.
pub const EPOCH_CURRENT_OP: &str = "fleet.epoch_current";

/// The marker in Entorhinal's `entorhinal.changes` bucket that changes when
/// either member of the record does.
pub const EPOCH_MARKER: &str = "fleet_epoch";

/// The body of `fleet.epoch_current {}`.
pub fn status_request() -> Vec<u8> {
    serde_json::to_vec(&json!({"method": EPOCH_CURRENT_OP, "params": {}}))
        .expect("a request is JSON")
}

/// The record in Entorhinal's answer `{"result": {"current": n,
/// "highest_held": m}}`, a member left out or not a whole number being
/// unknown. An answer that isn't one (a refusal, an unknown operation on an
/// Entorhinal without it) leaves both unknown.
pub fn parse_status(reply: &[u8]) -> EpochStatus {
    let Ok(value) = serde_json::from_slice::<Value>(reply) else {
        return EpochStatus::default();
    };
    let Some(result) = value.get("result") else {
        return EpochStatus::default();
    };
    EpochStatus {
        current: result.get("current").and_then(Value::as_u64),
        highest_held: result.get("highest_held").and_then(Value::as_u64),
    }
}

/// How long reading the record may take before it counts as unknown.
const STATUS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// The record from Entorhinal's management surface, over ck-mc's SDK
/// consumer. Entorhinal answers local callers.
pub struct EntorhinalEpochs {
    consumer: crate::transport::SharedConsumer,
}

impl EntorhinalEpochs {
    pub fn over(consumer: crate::transport::SharedConsumer) -> Arc<Self> {
        Arc::new(Self { consumer })
    }
}

#[async_trait]
impl FleetEpochs for EntorhinalEpochs {
    async fn status(&self) -> EpochStatus {
        use subc_client_rs::CallOptions;
        use subc_protocol::{BindIdentity, RouteTarget};
        let Ok(consumer) = self.consumer.get().await else {
            return EpochStatus::default();
        };
        let reply = consumer
            .call(
                RouteTarget::ManagementSurface {
                    module_id: "entorhinal".to_owned(),
                },
                // Grants nothing: Entorhinal answers by the route's caller.
                BindIdentity::new("magic-context", "fleet-epoch"),
                status_request(),
                CallOptions {
                    timeout: STATUS_TIMEOUT,
                    ..CallOptions::default()
                },
            )
            .await;
        match reply {
            Ok(bytes) => parse_status(&bytes),
            Err(_) => EpochStatus::default(),
        }
    }
}

/// What a refusal to open a message means.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unopened {
    /// The message may open later: the engine holds its position before
    /// it and reads it again. `alert` asks for an error-level log line,
    /// for a state someone should look at.
    Hold { why: String, alert: bool },
    /// The message can never open: it is recorded and skipped.
    Skip(String),
}

/// The vault's code for an item it can't open with the epoch key it holds
/// (a tag, additional data or caller domain that doesn't match). Today's
/// vault also gives it for an epoch it doesn't hold.
pub const OPEN_FAILED: &str = "fleet_epoch_open_failed";

/// What the vault's refusal `code` (of `class`) to open a message sealed
/// under `epoch` means, given whether this computer has opened a message
/// of that epoch before (`opened`) and the epoch record `status`.
///
/// - An epoch above the hub's current one is held, and alerted: the cached
///   record may lag a rotation another computer just made, and its marker
///   brings the retry once it catches up.
/// - `fleet_epoch_open_failed` is skipped for good for an epoch the vault
///   holds (at or below `highest_held`): the key is there and still doesn't
///   open the message. For an epoch above it, the epoch's wrap hasn't
///   arrived, so it is held. While `highest_held` is unknown, only an epoch
///   this computer has opened before counts as held by the vault.
/// - `corrupt` is the vault's own copy of the key damaged, not the
///   message: held, and alerted.
/// - Every other code (`fleet_epoch_unavailable`, `store_error`, or one this
///   build doesn't know) is held.
pub fn unopened(
    code: &str,
    class: &str,
    epoch: u64,
    opened: bool,
    status: EpochStatus,
) -> Unopened {
    if let Some(current) = status.current.filter(|current| epoch > *current) {
        return Unopened::Hold {
            why: format!(
                "the vault answered {code} ({class}) for epoch {epoch}, above the hub's current epoch {current} as this computer last read it; it is read again when the epoch record changes"
            ),
            alert: true,
        };
    }
    if code == OPEN_FAILED {
        let held_by_vault = match status.highest_held {
            Some(highest) => epoch <= highest,
            None => opened,
        };
        if held_by_vault {
            return Unopened::Skip(format!(
                "not opened: {code} under epoch {epoch}, which this computer's vault holds"
            ));
        }
        return Unopened::Hold {
            why: format!(
                "the vault answered {code} for epoch {epoch}, which this computer's vault doesn't hold yet; it is read again when the epoch arrives"
            ),
            alert: false,
        };
    }
    Unopened::Hold {
        why: format!(
            "the vault answered {code} ({class}) for epoch {epoch}; it is read again later"
        ),
        alert: code == "corrupt",
    }
}

/// The vault's code for a call it refused as malformed: ck-mc's own fault,
/// so it is held and alerted.
pub const INVALID_PARAMS: &str = "invalid_params";
