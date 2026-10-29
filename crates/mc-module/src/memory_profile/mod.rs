//! Frozen profile chains and durable memory-profile selections scoped to a session.
#![allow(dead_code)]

mod bundled;
pub(crate) mod documents;
mod frames;
mod load;
mod resolve;
mod schema;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) use load::{load_chain, Package, Profile};
// Profile identity and category lookup are shared with memory writers and personas.
pub(crate) use resolve::persist_session_pin;
#[allow(unused_imports)]
pub(crate) use resolve::{bind, project_profile, resolve, MemoryContext, ProfilePin};

/// All accepted session-entry paths use the same write-once persistence rule.
pub(crate) async fn bind_session(
    store: &mc_store::McStore,
    connection_file: Option<std::path::PathBuf>,
    identity: subc_protocol::BindIdentity,
    session_id: &str,
    agent_id: Option<&str>,
) {
    let result =
        match resolve_session_pin(store, connection_file, identity, session_id, agent_id).await {
            Ok(pin) => persist_session_pin(store, session_id, &pin),
            Err(error) => Err(error),
        };
    if let Err(error) = result {
        tracing::warn!(%error, session = session_id, "memory-profile context could not be persisted at bind");
    }
}

/// Read or resolve a session pin without creating or updating any metadata row.
pub(crate) async fn resolve_session_pin(
    store: &mc_store::McStore,
    connection_file: Option<std::path::PathBuf>,
    identity: subc_protocol::BindIdentity,
    session_id: &str,
    agent_id: Option<&str>,
) -> std::result::Result<MemoryContext, mc_store::McStoreError> {
    let folder = identity.project_root.to_string_lossy().into_owned();
    let source = crate::memory_context::MemoryContextReader::new(connection_file, identity);
    resolve::resolve_session_pin(&source, store, session_id, &folder, agent_id).await
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Refusal {
    pub code: String,
    pub detail: String,
}
type Result<T> = std::result::Result<T, Refusal>;
fn refuse(code: &str, detail: impl Into<String>) -> Refusal {
    Refusal {
        code: code.into(),
        detail: detail.into(),
    }
}
fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map(Vec::as_slice).unwrap_or_default()
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

#[cfg(test)]
mod tests;
