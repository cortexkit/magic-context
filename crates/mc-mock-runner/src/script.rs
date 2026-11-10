//! Scenario scripts: what happens in a session, step by step. The model's
//! replies are scripted too, so a run is deterministic and a scenario states
//! exactly how much reasoning, text and tool output each step produces.

use cortexkit_role_compaction::part::ToolStatus;
use cortexkit_role_compaction::rules::ProviderRules;
use cortexkit_role_compaction::setup::ModelRef;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum Step {
    /// A person (or the agent that launched the session) sends a message,
    /// which starts a run.
    User { text: String },
    /// A message with `images` pasted inline images after its text.
    UserWithImages { text: String, images: u64 },
    /// One model request. The runner first applies any view that arrived,
    /// asks for a view when the cache is lost or the request would not fit,
    /// then sends the request and stores the reply. Tool calls in the reply
    /// run right after, and their results are stored on the same message.
    Model(Turn),
    /// Time passes with nothing sent, in milliseconds.
    Wait { ms: u64 },
    /// Wait on real provider work without advancing the scenario's clock.
    Await {
        condition: AwaitCondition,
        timeout_ms: u64,
    },
    /// The session switches model, window or provider rules.
    ChangeModel {
        model: ModelRef,
        context_window: u64,
        output_reserve: u64,
        rules: ProviderRules,
    },
    /// The host removes every message from this ordinal on, as an undo does.
    Revert { ordinal: u64 },
    /// The session's tool set changes: a tool is added, removed or renamed,
    /// or its description or schema changes. The tool definitions come
    /// before the messages, so the cached prefix is gone. On a route whose
    /// signed reasoning is bound to the request prefix, the runner records
    /// its signed floor at the newest entry and, from the next request on,
    /// strips the signed reasoning at or before it (runner contract
    /// §11.1.1).
    ChangeTools,
    /// The runner restarts: it keeps its stored transcript and view, forgets
    /// when it last sent, and calls Setup again.
    RestartRunner,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "condition", rename_all = "snake_case")]
pub enum AwaitCondition {
    /// A session-bound tool reply fences all previously acknowledged notices.
    NoticesProcessed,
    /// The runner has received at least this many child-session sends.
    ChildRuns { count: usize },
}

/// The model's reply to one request.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Turn {
    /// Reasoning tokens the reply starts with, if any.
    pub reasoning_tokens: Option<u64>,
    /// Visible reasoning text, for a provider that returns some.
    pub reasoning_text: Option<String>,
    pub text: Option<String>,
    /// How the model starts its text.
    pub self_tag: SelfTag,
    pub tools: Vec<ToolCall>,
    pub output_tokens: u64,
}

/// The tag prefix a model writes at the start of its reply's text.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelfTag {
    /// One more than the highest number it can see, as it is told to.
    #[default]
    Next,
    /// None at all.
    Missing,
    /// A number of its own choosing.
    Number(u64),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCall {
    pub name: String,
    pub input: Value,
    /// The result. For a `ctx_*` tool the compaction provider answers
    /// instead, and this is ignored.
    pub output: String,
    pub status: ToolStatus,
    /// Inline images the result carries, such as a screenshot.
    #[serde(default)]
    pub images: u64,
}

impl ToolCall {
    /// The same call, with `images` inline images in its result.
    pub fn with_images(mut self, images: u64) -> Self {
        self.images = images;
        self
    }

    pub fn ok(name: &str, input: Value, output: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            input,
            output: output.into(),
            status: ToolStatus::Completed,
            images: 0,
        }
    }
}
