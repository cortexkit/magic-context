//! `compaction.ride`, served by the provider. The runner asks for a view now,
//! just before a request that rewrites its prompt cache anyway, or that would
//! not fit. The provider answers within the deadline with a view to apply, or
//! with nothing. The wait only ever lands on a request that is already paying
//! a full cache write, or that would otherwise be refused.

use serde::{Deserialize, Serialize};

use crate::notice::Conditions;
use crate::read::SessionRef;
use crate::view::AppliedView;

/// The refusal code a runner gives a run whose next request still does not
/// fit after an `over_limit` ride. It never sends a request over its limit.
pub const CONTEXT_CEILING: &str = "context_ceiling";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RideRequest {
    pub session: SessionRef,
    pub cause: RideCause,
    /// How long the runner waits for the answer, in milliseconds. A cold
    /// start gets a longer deadline, since the provider may first have to
    /// read the transcript.
    pub deadline_ms: u64,
    pub conditions: Conditions,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_view: Option<AppliedView>,
    /// For [`RideCause::OverLimit`]: the runner's estimate, in tokens, of the
    /// request it is about to send.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_tokens: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RideCause {
    /// The prompt cache expired: the runner's last send (keep-warm requests
    /// included) is older than the cache lifetime it requested, or it cannot
    /// know, for example after its own restart.
    CacheExpired,
    /// The runner restarts its request chain (OpenAI chained requests).
    ChainReset,
    ModelChange,
    TierChange,
    AccountChange,
    /// The system prompt or the tool definitions changed.
    SurfaceChange,
    /// The next request would exceed `context_window - output_reserve`.
    OverLimit,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "answer", rename_all = "snake_case")]
pub enum RideAnswer {
    /// Fetch this view with `view.get` and apply it to the coming request.
    View { version: u64, checksum: String },
    /// Keep the current view.
    Nothing,
}
