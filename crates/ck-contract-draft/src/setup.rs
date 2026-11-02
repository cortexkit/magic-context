//! `compaction.setup`, served by the provider. The runner calls it once when
//! it starts serving a session, including after its own restart. Setup only
//! announces the session; it never carries messages, and the provider reads
//! the transcript afterwards, never inside Setup.
//!
//! The session and its project come from the route, not from the request:
//! the route's bind identity names the session, and the daemon's scope stamp
//! on the route names the session's folder and project.

use serde::{Deserialize, Serialize};

use crate::read::Cursor;
use crate::rules::ProviderRules;
use crate::view::AppliedView;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SetupRequest {
    /// The session's preset, for example `head`, `worker` or `reader`. The
    /// provider decides what each preset enables.
    pub preset: String,
    pub model: ModelRef,
    /// The model's context window in tokens.
    pub context_window: u64,
    /// Tokens the runner keeps free for the reply. The runner never sends a
    /// request larger than `context_window - output_reserve`.
    pub output_reserve: u64,
    pub rules: ProviderRules,
    /// The view the runner applies now, absent when it applies none. After a
    /// runner restart this is the view it reloaded from its own store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_view: Option<AppliedView>,
    /// The newest transcript entry, absent for an empty transcript.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newest: Option<Cursor>,
    /// The runner's clock, in milliseconds since the Unix epoch.
    pub now: u64,
}

/// The model the session currently uses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRef {
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    /// The provider's service tier (for example OpenAI's `priority`), when it
    /// is not the default. A tier change loses the prompt cache like a model
    /// change does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "answer", rename_all = "snake_case")]
pub enum SetupAnswer {
    /// The provider manages the session from now on.
    Ready,
}
