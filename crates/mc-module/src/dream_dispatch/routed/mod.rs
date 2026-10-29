//! Dream runs placed by routing (module-only ck-mc).
//!
//! A routed dream run belongs to its project, not to any conversation: ck-mc
//! registers a project scope of its own for each child ([`scope`]), selects a
//! route for the task's consumer under it, and runs the child on the runner
//! routing named ([`carrier`]). Which tasks exist, and what each asks routing
//! for, is in [`registry`]. The outside world is behind [`wire::DreamWire`].
//!
//! [`choose_path`] decides, per project, whether a run takes this path or one of
//! the older transports (configured Broca, a conversation's own
//! runner): routed only when the scope can be registered at all.

pub mod carrier;
pub mod fetch_plan;
mod live;
mod production;
pub mod registry;
mod runner_port;
pub mod scope;
pub mod wire;

use wire::WireRefusal;

/// How one project's dream run is carried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DreamPath {
    /// Through routing, under the run's own project scope.
    Routed,
    /// Through the transport the project was last seen with.
    Legacy,
}

/// The path a project's run takes. `support` is whether this build can register
/// a dream project scope; `legacy_available` whether an older transport applies
/// to the project (a conversation's own runner or a configured
/// Broca runner). Until the scope can be registered, a project an older
/// transport can carry keeps dreaming exactly as before, and only a project
/// nothing else can carry is refused, by the scope refusal's name.
pub fn choose_path(
    support: Result<(), WireRefusal>,
    legacy_available: bool,
) -> Result<DreamPath, WireRefusal> {
    match support {
        Ok(()) => Ok(DreamPath::Routed),
        Err(_) if legacy_available => Ok(DreamPath::Legacy),
        Err(refusal) => Err(refusal),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unsupported() -> Result<(), WireRefusal> {
        Err(WireRefusal {
            code: wire::SCOPE_UNSUPPORTED.into(),
            detail: String::new(),
        })
    }

    #[test]
    fn routed_only_when_the_scope_can_be_registered() {
        assert_eq!(choose_path(Ok(()), true), Ok(DreamPath::Routed));
        assert_eq!(choose_path(Ok(()), false), Ok(DreamPath::Routed));
        assert_eq!(choose_path(unsupported(), true), Ok(DreamPath::Legacy));
        assert_eq!(
            choose_path(unsupported(), false).unwrap_err().code,
            wire::SCOPE_UNSUPPORTED
        );
    }
}
