//! What a call's route says about the session it concerns. Every op a runner
//! calls arrives on a route bound to one session, and every fact that decides
//! whose data a call reaches comes from that route, never from the request
//! body, which the caller could forge:
//! - the runner is the module the daemon attests for the route;
//! - the session is the identity the route is bound to;
//! - the project is the daemon's scope stamp on the route.

use cortexkit_role_compaction::read::SessionRef;

/// A session's project: the id its memories and notes are kept under, and
/// the folder its docs and configuration are read from.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Project {
    pub id: String,
    pub root: String,
}

/// The session a route is bound to, and its project when the route's scope
/// names one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Route {
    pub session: SessionRef,
    pub project: Option<Project>,
    /// The scope's folder. Core may stamp a folder without a project id (while
    /// the project registry is unreachable, or for a checkout outside every
    /// registered project); such
    /// a session has no project, but its configuration and its summarizer's
    /// child sessions still use this folder. Equal to `project.root` when
    /// both are stamped.
    pub workdir: Option<String>,
    /// The agent the scope works for, when it names one. It picks the
    /// memory profile the agent pins (spec 3c, ML1); attribution only, never
    /// authority.
    pub agent_id: Option<String>,
}
