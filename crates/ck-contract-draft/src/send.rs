//! `session.send` and `run.result`, served by the runner. These mirror the
//! llm-runner contract's ops of the same names, in the subset a compaction
//! provider uses, and keep their field names:
//! - text queued for a session's model (a reminder), delivered by riding a
//!   tool result or as a notice message;
//! - a model run in a child session the provider owns, such as a summarizer
//!   turn, whose reply the provider reads with `run.result`.
//!
//! These types are a stand-in for the mock runner and ck-mc while the draft
//! is built; the contract uses llm-runner's published types for both ops, and
//! these go once ck-mc and the mock switch to them. Like every op here, they
//! name no session: the route is bound to it.

use serde::{Deserialize, Serialize};

use cortexkit_role_compaction::read::StepUsage;
use cortexkit_role_compaction::setup::ModelRef;

/// How queued text may be delivered, in the sender's order of preference.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    /// Appended to the next tool result, the first time that result is sent.
    /// Costs nothing extra; never starts a model step of its own.
    ToolResult,
    /// Stored as a notice message before the next model request. Use it only
    /// for text the model must act on.
    Steer,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SendRequest {
    /// The idempotency key: a repeat with the same key does nothing new.
    pub send_id: String,
    pub prompt: String,
    /// For queued text: names the kind of text, so a reader of the transcript
    /// can tell module notices apart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// For queued text: how it may be delivered. Empty starts a run instead.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delivery: Vec<Delivery>,
    /// For a run: what it runs with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<RunSettings>,
}

/// A run's settings, flattened into `session.send` as llm-runner carries them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunSettings {
    /// The child session the run happens in: a session of the provider's
    /// own under `session`, created on first use. Nothing it holds reaches
    /// the parent's transcript, and a later run in the same child continues
    /// its conversation.
    pub child: String,
    pub system: String,
    pub model: ModelRef,
    /// The routing `decision_id` the model was picked under (SR4). A runner
    /// that gets its accounts from routing passes it to `route.account_for`;
    /// one that runs models through its host's own login ignores it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_decision_id: Option<String>,
    pub generation: Generation,
    pub stop_when: StopWhen,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Generation {
    pub max_output_tokens: u64,
    /// Left out where a runner declares it does not support it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StopWhen {
    pub max_steps: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SendAnswer {
    /// Queued text was stored for delivery.
    Queued,
    /// A run started; read its reply with `run.result`.
    Active { run_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunResultRequest {
    pub run_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunResult {
    pub run_id: String,
    pub state: RunState,
    /// Why the model stopped, normalized as llm-runner does: `stop`,
    /// `length` (it hit its output limit), or another reason. Absent when the
    /// runner was not told; a reply without one is never taken as complete
    /// just because it parses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish: Option<String>,
    /// The reply's text, once finished.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<StepUsage>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Active,
    Finished,
    Failed,
}
