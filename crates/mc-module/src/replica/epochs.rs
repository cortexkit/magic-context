//! Which fleet epochs exist, and what a vault refusal to open a message
//! means for the stream.
//!
//! A message is sealed under the fleet epoch current on the computer that
//! sent it. A computer whose vault doesn't hold that epoch's key yet (a
//! newly paired one, or one the new epoch's key, which the hub hands each
//! paired computer wrapped for its vault, hasn't reached yet) can't open it
//! now but will later, so such a message is never skipped for good:
//! the engine holds its position before it and reads it again
//! ([`super::apply`]). Only a message the vault can never open is skipped.
//!
//! [`unopened`] decides which, in one place, from the vault's own refusal
//! code alone. The hub's epoch record as Entorhinal (the module that tracks
//! this computer's fleet membership) reports it
//! ([`FleetEpochs`], `fleet.epoch_current`: `current`, the hub's current
//! epoch as this computer last saw it, and `highest_held`, the highest
//! epoch this computer's vault holds) never decides a skip, because a vault
//! can hold an epoch and miss one below it; it only says, in the hold's
//! reason, when a retry may help. When a member changes, Entorhinal bumps
//! its `fleet_epoch` marker, and the replica task reads a held message
//! again at once ([`super::live`]).

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
    /// for a state someone should look at. `missing` is the fleet epoch
    /// this computer's vault doesn't hold, when that is why: the engine
    /// records that hold for the person to see ([`super::hold_status`]).
    Hold {
        why: String,
        alert: bool,
        missing: Option<u64>,
    },
    /// The message can never open: it is recorded and skipped.
    Skip(String),
}

/// The vault's code for an item of an epoch whose key it holds that still
/// doesn't open: its bytes or additional data don't authenticate. The
/// message never opens anywhere.
pub const OPEN_FAILED: &str = "fleet_epoch_open_failed";

/// The vault's code for an item of an epoch whose key it doesn't hold.
pub const UNAVAILABLE: &str = "fleet_epoch_unavailable";

/// What the vault's refusal `code` (of `class`) to open a message sealed
/// under `epoch` means. The vault's own answer decides; the epoch record
/// `status` only says, in the hold's reason, what this computer last read
/// of the hub's epochs.
///
/// - `fleet_epoch_open_failed` is skipped for good, whatever the epoch:
///   the vault holds that epoch's key, and the message doesn't
///   authenticate under it. (Memory sharing between computers is only
///   switched on with a vault that gives these two answers; an older vault
///   also answered `fleet_epoch_open_failed` for an epoch it lacked.)
/// - `fleet_epoch_unavailable` is held, and alerted: the vault doesn't
///   hold the epoch's key yet. Nothing is sent meanwhile, so the person
///   must see it and get the key to the vault; the engine records the hold
///   with the epoch it waits for.
/// - `corrupt` is the vault's own copy of the key damaged, not the
///   message: held, and alerted.
/// - Every other code (`store_error`, or one this build doesn't know) is
///   held.
pub fn unopened(code: &str, class: &str, epoch: u64, status: EpochStatus) -> Unopened {
    if code == OPEN_FAILED {
        return Unopened::Skip(format!(
            "not opened: {code} under epoch {epoch}, which this computer's vault holds"
        ));
    }
    if code == UNAVAILABLE {
        let known =
            |value: Option<u64>| value.map_or_else(|| "unknown".to_owned(), |n| n.to_string());
        return Unopened::Hold {
            why: format!(
                "the vault answered {code} ({class}) for epoch {epoch}: this computer's vault doesn't hold that epoch's key, so nothing is sent until it does (the hub's current epoch is {}, and the highest this vault holds is {}, as last read); it is read again when the epoch record changes",
                known(status.current),
                known(status.highest_held)
            ),
            alert: true,
            missing: Some(epoch),
        };
    }
    Unopened::Hold {
        why: format!(
            "the vault answered {code} ({class}) for epoch {epoch}; it is read again later"
        ),
        alert: code == "corrupt",
        missing: None,
    }
}

/// The vault's code for a call it refused as malformed: ck-mc's own fault,
/// so it is held and alerted.
pub const INVALID_PARAMS: &str = "invalid_params";
