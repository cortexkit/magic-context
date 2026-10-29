//! Coherent Entorhinal reads for memory authority, separate from served
//! transforms and prompt rendering.

// The memory-authority API is not yet called by production session binding.
#![allow(dead_code)]

mod ento;
mod snapshot;

use cortexkit_agent_identity::ContextPin;
use cortexkit_project_identity::{Presence, RefusalCode};
use serde::de::DeserializeOwned;
use serde::Serialize;

pub(crate) type MemoryContextReader = ento::MemoryContextReader;
pub(crate) type ProjectContext = cortexkit_agent_identity::ContextProjectReply;
pub(crate) type SessionContext = cortexkit_agent_identity::ContextSessionReply;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ContextAnswer<T> {
    Answer(T),
    Refused {
        code: RefusalCode,
        message: String,
        detail: serde_json::Value,
    },
    NotAnswering,
}

pub(crate) fn pin_blocked(pin: &ContextPin) -> bool {
    pin.status.as_ref().is_some_and(|status| status.blocked)
}

pub(crate) fn snapshot_digest(project: &ProjectContext) -> String {
    snapshot::digest(project)
}

// The shared wire types intentionally accept future fields and missing nullable
// keys. This reader requires a complete, closed authority snapshot: ento compares
// the decoded/re-serialized result with its raw JSON before accepting it.
pub(super) trait ContextReply: DeserializeOwned + Serialize {
    fn valid_for_context(&self) -> bool {
        true
    }
}

impl ContextReply for ProjectContext {}

impl ContextReply for SessionContext {
    fn valid_for_context(&self) -> bool {
        // context.session refuses terminal agents before building a result. The
        // standalone agent.resolve reply is wider than this successful shape.
        self.agent.gone.is_none()
            && self.agent.merged_into.is_none()
            && match &self.whereabouts.moving {
                // Only standalone whereabouts reads add the elapsed duration.
                Presence::Present(moving) => matches!(moving.waiting_ms, Presence::Missing),
                Presence::Missing => true,
                _ => false,
            }
    }
}

#[cfg(test)]
mod tests;
