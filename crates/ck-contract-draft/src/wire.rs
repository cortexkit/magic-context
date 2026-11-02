//! How every op travels between modules. A request body is the JSON object
//! `{"method": <op name>, "params": <the op's request>}`; a successful answer
//! is the op's answer as JSON. A refusal travels as the transport's error
//! frame, with a stable code and a message for people.
//!
//! Model tool calls and the edit to a person's message before it is stored are
//! not part of this contract: they use the published `tool-provider/v1` and
//! `step-transform-provider/v1` contracts, each on a route of its own.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
