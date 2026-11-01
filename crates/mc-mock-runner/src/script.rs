//! Scenario scripts: what happens in a session, step by step. The model's
//! replies are scripted too, so a run is deterministic and a scenario states
//! exactly how much reasoning, text and tool output each step produces.

use ck_contract_draft::part::ToolStatus;
use ck_contract_draft::rules::ProviderRules;
use ck_contract_draft::setup::ModelRef;
use serde_json::Value;

#[derive(Clone, Debug)]
pub enum Step {
    /// A person (or the agent that launched the session) sends a message,
    /// which starts a run.
    User { text: String },
    /// One model request. The runner first applies any view that arrived,
    /// asks for a view when the cache is lost or the request would not fit,
    /// then sends the request and stores the reply. Tool calls in the reply
    /// run right after, and their results are stored on the same message.
    Model(Turn),
    /// Time passes with nothing sent, in milliseconds.
    Wait { ms: u64 },
    /// The session switches model, window or provider rules.
    ChangeModel {
        model: ModelRef,
        context_window: u64,
        output_reserve: u64,
        rules: ProviderRules,
    },
    /// The host removes every message from this ordinal on, as an undo does.
    Revert { ordinal: u64 },
    /// The runner restarts: it keeps its stored transcript and view, forgets
    /// when it last sent, and calls Setup again.
    RestartRunner,
}

/// The model's reply to one request.
#[derive(Clone, Debug, Default)]
pub struct Turn {
    /// Reasoning tokens the reply starts with, if any.
    pub reasoning_tokens: Option<u64>,
    /// Visible reasoning text, for a provider that returns some.
    pub reasoning_text: Option<String>,
    pub text: Option<String>,
    pub tools: Vec<ToolCall>,
    pub output_tokens: u64,
}

#[derive(Clone, Debug)]
pub struct ToolCall {
    pub name: String,
    pub input: Value,
    /// The result. For a `ctx_*` tool the compaction provider answers
    /// instead, and this is ignored.
    pub output: String,
    pub status: ToolStatus,
}

impl ToolCall {
    pub fn ok(name: &str, input: Value, output: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            input,
            output: output.into(),
            status: ToolStatus::Completed,
        }
    }
}
