//! A session's memory context: its project, workspace and
//! domain from Entorhinal, and the memory profile its agent pins. ck-mc reads
//! it once, at the session's first Setup (or first `ctx_memory` call, for a
//! session that only calls tools), and keeps it with the session. Only the
//! workspace is read again, at each later Setup ([`read_workspace`]), because
//! a head runs for months and its project can move to another workspace.
//! Ported from the memory-levels card (`crates/mc-module/src/memory_context/`
//! at `75adf757`).

mod snapshot;

use std::time::Duration;

use cortexkit_agent_identity::{ContextProjectParams, ContextSessionParams};
use cortexkit_project_identity::{Outcome, Presence, RefusalCode, Request};
use cortexkit_role_compaction::read::SessionRef;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::client::RunnerClient;
use crate::memory_profile::{resolve, MemoryContext};

pub(crate) type ProjectContext = cortexkit_agent_identity::ContextProjectReply;
pub(crate) type SessionContext = cortexkit_agent_identity::ContextSessionReply;

/// How long one Entorhinal read may take, wait for the connection included.
pub const DEADLINE: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ContextAnswer<T> {
    Answer(T),
    Refused {
        code: RefusalCode,
        message: String,
        detail: Value,
    },
    NotAnswering,
}

pub(crate) fn snapshot_digest(project: &ProjectContext) -> String {
    snapshot::digest(project)
}

/// Resolve a session's memory context: the project read for `folder`, the
/// agent's pins when the route names an agent, then the profile choice.
/// Never fails: a read that does not answer resolves to the bundled profile
/// with state `entorhinal_not_answering`.
pub(crate) async fn read<C: RunnerClient>(
    client: &C,
    session: &SessionRef,
    folder: &str,
    agent_id: Option<&str>,
) -> MemoryContext {
    let project = read_one::<C, ProjectContext, _>(
        client,
        session,
        Request::new(
            "context.project",
            ContextProjectParams::new(folder.to_owned()),
        ),
    )
    .await;
    let agent = match agent_id {
        Some(agent) => {
            read_one::<C, SessionContext, _>(
                client,
                session,
                Request::new(
                    "context.session",
                    ContextSessionParams::new(agent.to_owned()),
                ),
            )
            .await
        }
        None => ContextAnswer::NotAnswering,
    };
    resolve(&project, &agent, &[])
}

/// The project and workspace Entorhinal places `folder` in now, or `None`
/// when it doesn't answer or refuses (the session then keeps what it has).
pub(crate) async fn read_workspace<C: RunnerClient>(
    client: &C,
    session: &SessionRef,
    folder: &str,
) -> Option<(Option<String>, Option<String>)> {
    match read_one::<C, ProjectContext, _>(
        client,
        session,
        Request::new(
            "context.project",
            ContextProjectParams::new(folder.to_owned()),
        ),
    )
    .await
    {
        ContextAnswer::Answer(project) => Some((project.project_id, project.workspace_id)),
        _ => None,
    }
}

async fn read_one<C: RunnerClient, T: ContextReply, P: Serialize>(
    client: &C,
    session: &SessionRef,
    request: Request<P>,
) -> ContextAnswer<T> {
    let body = serde_json::to_vec(&request).expect("context request is JSON");
    match tokio::time::timeout(DEADLINE, client.entorhinal_call(session, body)).await {
        Ok(Some(Ok(bytes))) => decode_reply(&bytes),
        Ok(Some(Err(refusal)))
            if !matches!(refusal.code.as_str(), "unknown_module" | "unknown_method") =>
        {
            ContextAnswer::Refused {
                code: serde_json::from_value(Value::String(refusal.code))
                    .expect("refusal codes include unknown strings"),
                message: refusal.message,
                detail: refusal.detail.unwrap_or(Value::Null),
            }
        }
        _ => ContextAnswer::NotAnswering,
    }
}

// The shared wire types accept future fields and missing nullable keys. A
// memory context needs a complete, closed snapshot, so a reply is accepted
// only when decoding and re-serializing it gives back its raw JSON.
pub(crate) trait ContextReply: DeserializeOwned + Serialize {
    fn valid_for_context(&self) -> bool {
        true
    }
}

impl ContextReply for ProjectContext {}

impl ContextReply for SessionContext {
    fn valid_for_context(&self) -> bool {
        // context.session refuses a gone or merged agent before building a
        // result; only a standalone whereabouts read adds the elapsed time.
        self.agent.gone.is_none()
            && self.agent.merged_into.is_none()
            && match &self.whereabouts.moving {
                Presence::Present(moving) => matches!(moving.waiting_ms, Presence::Missing),
                Presence::Missing => true,
                _ => false,
            }
    }
}

fn decode_reply<T: ContextReply>(bytes: &[u8]) -> ContextAnswer<T> {
    let (Ok(raw), Ok(outcome)) = (
        serde_json::from_slice::<Value>(bytes),
        serde_json::from_slice::<Outcome<T>>(bytes),
    ) else {
        return ContextAnswer::NotAnswering;
    };
    match outcome {
        Outcome::Success(success)
            if raw.as_object().is_some_and(|object| object.len() == 1)
                && success.result.valid_for_context()
                && serde_json::to_value(&success.result).ok().as_ref() == raw.get("result") =>
        {
            ContextAnswer::Answer(success.result)
        }
        Outcome::Refusal(refusal)
            if raw.as_object().is_some_and(|object| {
                object.contains_key("code")
                    && object.contains_key("message")
                    && object
                        .keys()
                        .all(|key| matches!(key.as_str(), "code" | "message" | "detail"))
            }) && !matches!(
                raw.get("code").and_then(Value::as_str),
                Some("unknown_module" | "unknown_method")
            ) =>
        {
            ContextAnswer::Refused {
                code: refusal.code,
                message: refusal.message,
                detail: refusal.detail.unwrap_or(Value::Null),
            }
        }
        _ => ContextAnswer::NotAnswering,
    }
}

#[cfg(test)]
mod entorhinal_sample_tests {
    use super::{decode_reply, ContextAnswer, SessionContext};

    /// Entorhinal's own `context.session` replies for an agent pinned to an
    /// automation flow, copied from the entorhinal repository's
    /// `test-vectors/catalog-packs-v1/context.json` (commit `a3238dd`).
    /// Entorhinal releases a reply shape only after every reader decodes
    /// it, so this module's strict reader must take both replies whole; the
    /// stale one carries `stale_since_ms` on its pin.
    #[test]
    fn entorhinal_flow_pin_context_replies_are_answers() {
        let samples: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../testdata/entorhinal-context-samples/context.json"
        ))
        .unwrap();
        let cases: Vec<&str> = samples
            .iter()
            .map(|sample| sample["case"].as_str().unwrap())
            .collect();
        assert_eq!(cases, ["fresh-flow-context", "stale-flow-context"]);
        for sample in &samples {
            let reply = sample["reply_bytes"].as_str().unwrap();
            let answer = decode_reply::<SessionContext>(reply.as_bytes());
            assert!(
                matches!(answer, ContextAnswer::Answer(_)),
                "{} was not accepted: {answer:?}",
                sample["case"]
            );
        }
        assert!(samples[1]["reply_bytes"]
            .as_str()
            .unwrap()
            .contains("stale_since_ms"));
    }
}
