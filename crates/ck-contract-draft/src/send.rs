//! `session.send`, served by the runner: a module queues text for the model.
//! The draft carries it because ck-mc needs it; it belongs to the llm-runner
//! contract's reminder delivery when published.

use serde::{Deserialize, Serialize};

use crate::read::SessionRef;

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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendRequest {
    pub session: SessionRef,
    pub text: String,
    /// Names the kind of text, so a reader of the transcript can tell
    /// module notices apart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    pub delivery: Vec<Delivery>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "answer", rename_all = "snake_case")]
pub enum SendAnswer {
    Queued,
}
