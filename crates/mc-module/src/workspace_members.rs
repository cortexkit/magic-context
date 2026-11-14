//! The projects of a workspace as Entorhinal lists them: the workspace's
//! display name and each member project's id and name, read with
//! Entorhinal's `enumerate` for that one workspace.
//!
//! A read waits at most [`DEADLINE`]. Its outcome is kept per workspace, an
//! answer for [`FRESH`] and a missing answer for [`RETRY`], so a caller that
//! asks on every summary run waits on Entorhinal only now and then. At most
//! [`CAPACITY`] workspaces are kept. When Entorhinal doesn't answer, the
//! outcome says so ([`Lookup::NotAnswering`]) and the caller decides what
//! that means for it.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cortexkit_project_identity::{EnumerateParams, EnumerateReply, Outcome, RefKind, Request};
use cortexkit_role_compaction::read::SessionRef;

use crate::client::RunnerClient;

/// How long one `enumerate` may take.
pub(crate) const DEADLINE: Duration = Duration::from_secs(2);
/// How long an answer is used again before Entorhinal is asked anew.
const FRESH: Duration = Duration::from_secs(10 * 60);
/// How long after a read Entorhinal didn't answer it is not asked again.
const RETRY: Duration = Duration::from_secs(60);
/// The most workspaces kept at once; the oldest read goes first.
const CAPACITY: usize = 64;

/// A project of the workspace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Member {
    pub project_id: String,
    pub name: String,
}

/// A workspace and its projects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceMembers {
    pub workspace_id: String,
    /// The workspace's display name.
    pub name: String,
    /// Its projects on this machine, ordered by name, then id.
    pub members: Vec<Member>,
}

/// What Entorhinal says about one workspace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Lookup {
    Members(Arc<WorkspaceMembers>),
    /// Entorhinal answered and lists no such workspace.
    Unknown,
    /// Entorhinal didn't answer in time, refused, or answered something
    /// that doesn't decode.
    NotAnswering,
}

/// The session reference Entorhinal's workspace read is made under. It
/// names no real session, because the answer is shared by every session of
/// the workspace.
fn identity() -> SessionRef {
    SessionRef::new(crate::MODULE_ID, "magic-context", "workspace-members")
}

/// Ask Entorhinal for its projects, under `identity`: every project, or
/// only those of `workspace`. `None` when it doesn't answer within
/// [`DEADLINE`], refuses, or answers something that doesn't decode.
pub(crate) async fn enumerate<C: RunnerClient>(
    client: &C,
    identity: &SessionRef,
    workspace: Option<&str>,
) -> Option<EnumerateReply> {
    let request = Request::new(
        "enumerate",
        EnumerateParams::new(workspace.map(str::to_owned)),
    );
    let body = serde_json::to_vec(&request).expect("an enumerate request is JSON");
    let bytes = match tokio::time::timeout(DEADLINE, client.entorhinal_call(identity, body)).await {
        Ok(Some(Ok(bytes))) => bytes,
        _ => return None,
    };
    match serde_json::from_slice::<Outcome<EnumerateReply>>(&bytes) {
        Ok(Outcome::Success(success)) => Some(success.result),
        _ => None,
    }
}

/// `workspace` as `reply` lists it. Only local projects count: a remote
/// reference names another machine's project.
pub(crate) fn members_of(reply: &EnumerateReply, workspace: &str) -> Lookup {
    let Some(listed) = reply
        .workspaces
        .iter()
        .find(|listed| listed.workspace_id == workspace)
    else {
        return Lookup::Unknown;
    };
    let mut seen = BTreeSet::new();
    let mut members: Vec<Member> = reply
        .projects
        .iter()
        .filter(|project| {
            project.ref_kind == RefKind::Local
                && project.workspace_id.as_deref() == Some(workspace)
                && seen.insert(project.project_id.clone())
        })
        .map(|project| Member {
            project_id: project.project_id.clone(),
            name: project.name.clone(),
        })
        .collect();
    members.sort_by(|a, b| a.name.cmp(&b.name).then(a.project_id.cmp(&b.project_id)));
    Lookup::Members(Arc::new(WorkspaceMembers {
        workspace_id: workspace.to_owned(),
        name: listed.name.clone(),
        members,
    }))
}

/// Read outcomes by workspace id, with when each was read.
fn cache() -> &'static Mutex<HashMap<String, (Instant, Lookup)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Lookup)>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// The workspace `workspace` and its projects, as Entorhinal lists them now
/// or listed them recently.
pub(crate) async fn workspace_members<C: RunnerClient>(client: &C, workspace: &str) -> Lookup {
    let now = Instant::now();
    if let Some((read, lookup)) = cache().lock().expect("workspace cache").get(workspace) {
        let keep = if *lookup == Lookup::NotAnswering {
            RETRY
        } else {
            FRESH
        };
        if now.duration_since(*read) < keep {
            return lookup.clone();
        }
    }
    let lookup = match enumerate(client, &identity(), Some(workspace)).await {
        Some(reply) => members_of(&reply, workspace),
        None => Lookup::NotAnswering,
    };
    let mut cache = cache().lock().expect("workspace cache");
    if cache.len() >= CAPACITY && !cache.contains_key(workspace) {
        let oldest = cache
            .iter()
            .min_by_key(|(_, (read, _))| *read)
            .map(|(id, _)| id.clone());
        if let Some(oldest) = oldest {
            cache.remove(&oldest);
        }
    }
    cache.insert(workspace.to_owned(), (Instant::now(), lookup.clone()));
    lookup
}

#[cfg(test)]
#[path = "workspace_members_tests.rs"]
pub(crate) mod tests;
