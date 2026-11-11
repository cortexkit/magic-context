//! From a ref to the runner session it names.
//!
//! One ref is one runner session. Entorhinal registered it and resolves it
//! (`agent.session_for_ref` on its management surface), and its answer is
//! the only place the session's runner, harness and id come from: nothing
//! in the request is trusted to name a session.

use std::time::Duration;

use cortexkit_agent_identity::{
    AgentSessionForRefParams, AgentSessionForRefReply, Outcome, Presence,
    RefusalCode as EntorhinalCode, Request as EntorhinalRequest,
};
use cortexkit_role_agent_data::errors::{Detail, ErrorBody, RefusalCode, UnknownRefDetail};
use cortexkit_role_agent_data::refs::Ref;
use cortexkit_role_compaction::read::SessionRef;

use super::service::Host;
use super::SESSION_MOVED;

/// Every ref kind a move can name, with the module that owns the kind: the
/// runner the session runs under, which moves the session's transcript.
/// `describe` declares a kind only while its owner is in the catalog as a
/// participant, and a ref resolves only to a session of its kind's owner.
pub const REF_KINDS: &[(&str, &str)] = &[
    ("broca-session", "broca"),
    ("opencode2-session", "thalamus-harness"),
    ("pi-session", "thalamus-harness"),
    ("claude-code-session", "thalamus-harness"),
];

/// The module that owns a ref kind, if the kind is one a move can name.
pub fn owner(kind: &str) -> Option<&'static str> {
    REF_KINDS
        .iter()
        .find(|(known, _)| *known == kind)
        .map(|(_, owner)| *owner)
}

const SESSION_FOR_REF: &str = "agent.session_for_ref";

/// How long one lookup waits for Entorhinal.
const BUDGET: Duration = Duration::from_secs(5);

/// The bind identity a lookup is made under. It concerns no session of its
/// own, so it names ck-mc's move participant.
pub fn lookup_identity() -> SessionRef {
    SessionRef::new(crate::MODULE_ID, "magic-context", "agent-data")
}

/// The session a ref names, as `(runner, harness, session)`. A ref this
/// machine does not hold is refused `unknown_ref` naming it: a kind ck-mc
/// does not know, a ref Entorhinal has no session for, a binding that names
/// no runner or another runner than the kind's owner, and a session
/// released to another machine. A lookup that fails is `unavailable`, which
/// the driver retries.
pub(crate) async fn session<H: Host>(host: &H, r: &Ref) -> Result<SessionRef, ErrorBody> {
    let Some(owner) = owner(&r.ref_kind) else {
        return Err(unknown_ref(r, "ck-mc holds no ref of this kind"));
    };
    let request = EntorhinalRequest::new(
        SESSION_FOR_REF,
        AgentSessionForRefParams::new(r.ref_kind.clone(), r.r#ref.clone()),
    );
    let body = serde_json::to_vec(&request).expect("a lookup is JSON");
    let bytes = match tokio::time::timeout(BUDGET, host.entorhinal(body)).await {
        Ok(Some(Ok(bytes))) => bytes,
        Ok(Some(Err(refusal))) if refusal.code == "not_found" => {
            return Err(unknown_ref(r, "Entorhinal has no session under this ref"))
        }
        Ok(Some(Err(refusal))) => {
            return Err(unavailable(format!(
                "Entorhinal refused the ref lookup: {} ({})",
                refusal.code, refusal.message
            )))
        }
        Ok(None) | Err(_) => return Err(unavailable("Entorhinal did not answer the ref lookup.")),
    };
    let found: AgentSessionForRefReply = match serde_json::from_slice(&bytes) {
        Ok(Outcome::Success(success)) => success.result,
        Ok(Outcome::Refusal(refusal)) if refusal.code == EntorhinalCode::NotFound => {
            return Err(unknown_ref(r, "Entorhinal has no session under this ref"))
        }
        Ok(Outcome::Refusal(refusal)) => {
            return Err(unavailable(format!(
                "Entorhinal refused the ref lookup: {}",
                refusal.message
            )))
        }
        Ok(_) | Err(_) => {
            return Err(unavailable(
                "Entorhinal's answer to the ref lookup does not decode.",
            ))
        }
    };
    if found.ref_kind != r.ref_kind || found.session_ref != r.r#ref {
        return Err(unavailable(
            "Entorhinal answered the ref lookup for another ref.",
        ));
    }
    // The runner is the session's key and the owner check; a binding
    // without one cannot be checked, so it is never guessed.
    let (Presence::Present(runner), Some(harness), Some(id)) =
        (found.runner, found.harness, found.session_id)
    else {
        return Err(unknown_ref(
            r,
            "Entorhinal's binding for this ref names no runner session",
        ));
    };
    if runner != owner {
        return Err(unknown_ref(
            r,
            "the ref's session runs under another module than its kind's owner",
        ));
    }
    let session = SessionRef::new(runner, harness, id);
    if let Err(gated) = host.journal().gate().check(&session) {
        if gated.code == SESSION_MOVED {
            return Err(unknown_ref(
                r,
                &format!("session_moved: {}", gated.message.trim_end_matches('.')),
            ));
        }
    }
    Ok(session)
}

pub(crate) fn unknown_ref(r: &Ref, why: &str) -> ErrorBody {
    ErrorBody::with_typed_detail(
        Detail::UnknownRef(UnknownRefDetail::new(&r.ref_kind, &r.r#ref)),
        format!(
            "Magic Context does not hold {}/{}: {why}.",
            r.ref_kind, r.r#ref
        ),
    )
}

fn unavailable(message: impl Into<String>) -> ErrorBody {
    ErrorBody::new(RefusalCode::Unavailable, message)
}
