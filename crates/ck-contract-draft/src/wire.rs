//! How every op travels between modules. A request body is the JSON object
//! `{"method": <op name>, "params": <the op's request>}`; a successful answer
//! is the op's answer as JSON. A refusal travels as the transport's error
//! frame, with a stable code and a message for people.
//!
//! The draft also carries two ops that will come from other contracts when it
//! is published: model tool calls (`tool.call`, the tool-provider contract)
//! and the edit to a user message before it is stored (`transform.pre_user`,
//! the step-transform-provider contract). Their shapes here are what the mock
//! runner needs, not those contracts' final form.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::read::SessionRef;

#[derive(Serialize, Deserialize)]
struct Call<P> {
    method: String,
    params: P,
}

/// The body of a request for `method`.
pub fn encode<P: Serialize>(method: &str, params: &P) -> Vec<u8> {
    serde_json::to_vec(&Call {
        method: method.to_owned(),
        params,
    })
    .expect("op requests serialize")
}

/// Split a request body into its method and its still-encoded parameters.
pub fn decode(body: &[u8]) -> Result<(String, Value), String> {
    let call: Call<Value> =
        serde_json::from_slice(body).map_err(|error| format!("not an op request: {error}"))?;
    Ok((call.method, call.params))
}

/// Decode an op's parameters into its request type.
pub fn params<T: DeserializeOwned>(params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|error| format!("bad parameters: {error}"))
}

/// Error codes a refusal carries.
pub mod codes {
    /// The body is not an op request, or its parameters do not decode.
    pub const BAD_REQUEST: &str = "bad_request";
    /// The method is not one this module serves.
    pub const UNKNOWN_METHOD: &str = "unknown_method";
    /// The op names a session the module was never set up for.
    pub const UNKNOWN_SESSION: &str = "unknown_session";
    /// The op was understood and refused; the message says why.
    pub const REFUSED: &str = "refused";
}

/// Op names that come from other contracts (see the module docs).
pub mod ops {
    /// Served by the provider: a tool call the session's model made.
    pub const TOOL_CALL: &str = "tool.call";
    /// Served by the provider: edit a user message before it is stored.
    pub const PRE_USER: &str = "transform.pre_user";
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCallRequest {
    pub session: SessionRef,
    pub name: String,
    pub input: Value,
}

/// The tool's output for the model. A failed call is still an answer: the
/// model reads `output` either way, and `is_error` marks the result failed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCallAnswer {
    pub output: String,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PreUserRequest {
    pub session: SessionRef,
    pub text: String,
    /// The runner's clock as it stores the message, in milliseconds since the
    /// Unix epoch: the same clock as every entry's `written_at`, so the gap
    /// since the previous message is measured on one clock.
    pub now: u64,
}

/// Text to put before and after the user's message. Both absent changes
/// nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreUserAnswer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepend: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub append: Option<String>,
}
