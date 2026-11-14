//! The workspace guidance the curate tasks show: the text core (the
//! `prefrontal-core` module) puts inside `<workspace-guidance>` for the
//! agents of a workspace, from the guidance file in the workspace's root
//! folder. A memory that repeats a line of it adds nothing, so curate may
//! archive it as a duplicate that quotes the line.
//!
//! The engine asks core once per curate run, before the run is planned,
//! with `persona.workspace_document` on core's management surface. Core
//! reads the file afresh on every call. A run shows the guidance only when
//! core serves it (`served`) and its audience includes head agents
//! ([`HEAD`]): curate keeps the memories head agents read beside it. In
//! every other case (the workspace has no root folder or no file, core
//! refuses the file or the call, or core is not installed or doesn't
//! answer) the run shows no guidance and goes on, and the engine logs why
//! once. A refusal core marks retryable is not retried within the run; the
//! next run asks again.
//!
//! The guidance takes room in the message as the project documents do, so
//! guidance longer than one project document may be
//! ([`MAX_PROJECT_DOC_BYTES`]) is left out whole rather than cut.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::client::{CoreRefusal, RunnerClient};
use crate::project_docs::MAX_PROJECT_DOC_BYTES;
use crate::workspace_members::WorkspaceMembers;

/// Core's method that serves a workspace's guidance.
pub(crate) const METHOD: &str = "persona.workspace_document";
/// How long one call may take.
pub(crate) const DEADLINE: Duration = Duration::from_secs(5);
/// The audience role of head agents: the guidance is shown only when core
/// serves it to them.
pub(crate) const HEAD: &str = "head";

/// Core's answer for one workspace, by its `state`. Members a later core
/// adds are ignored.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum Document {
    /// The guidance: `body` is exactly the text core puts inside
    /// `<workspace-guidance>` for the agents whose roles `audience` lists.
    Served {
        workspace_id: String,
        root: String,
        digest: String,
        audience: Vec<String>,
        body: String,
    },
    /// The workspace has no root folder.
    NoRoot { workspace_id: String },
    /// Its root folder holds no guidance file.
    NoFile { workspace_id: String, root: String },
    /// Core found the file and refused it, for the reason `code` and
    /// `message` give.
    Refused {
        workspace_id: String,
        root: String,
        code: String,
        message: String,
    },
}

impl Document {
    fn workspace_id(&self) -> &str {
        match self {
            Document::Served { workspace_id, .. }
            | Document::NoRoot { workspace_id }
            | Document::NoFile { workspace_id, .. }
            | Document::Refused { workspace_id, .. } => workspace_id,
        }
    }
}

/// Core refused the call itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// `invalid_params`: core could not read the request.
    InvalidParams { message: String },
    /// `unknown_workspace`: core knows no workspace by that id.
    UnknownWorkspace { message: String },
    /// `workspace_index_unavailable`: core can't look workspaces up now. It
    /// marks the refusal retryable and may say when to ask again.
    IndexUnavailable {
        message: String,
        retryable: bool,
        retry_after_ms: Option<u64>,
    },
    /// Any other code.
    Other { code: String, message: String },
}

impl Refusal {
    fn of(refusal: CoreRefusal) -> Self {
        let CoreRefusal {
            code,
            message,
            detail,
        } = refusal;
        match code.as_str() {
            "invalid_params" => Refusal::InvalidParams { message },
            "unknown_workspace" => Refusal::UnknownWorkspace { message },
            "workspace_index_unavailable" => {
                let detail = detail.unwrap_or(Value::Null);
                Refusal::IndexUnavailable {
                    message,
                    retryable: detail["retryable"].as_bool().unwrap_or(false),
                    retry_after_ms: detail["retry_after_ms"].as_u64(),
                }
            }
            _ => Refusal::Other { code, message },
        }
    }
}

/// What came of asking core for one workspace's guidance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Reply {
    Document(Document),
    Refused(Refusal),
    /// No answer: core is not installed, can't be reached in time, or
    /// answered something that doesn't decode. The text says which.
    NotAnswering(String),
}

/// Core's answer to a request for `workspace`, `{"result": <document>}`, as
/// a document of that workspace.
pub(crate) fn decode(reply: &Value, workspace: &str) -> Result<Document, String> {
    let result = reply.get("result").ok_or("core's answer holds no result")?;
    let document = Document::deserialize(result)
        .map_err(|error| format!("core's answer doesn't decode: {error}"))?;
    if document.workspace_id() != workspace {
        return Err(format!(
            "core answered for workspace {} instead of {workspace}",
            document.workspace_id()
        ));
    }
    Ok(document)
}

/// Ask core once for `workspace`'s guidance, waiting at most [`DEADLINE`].
pub(crate) async fn read<C: RunnerClient>(client: &C, workspace: &str) -> Reply {
    let call = client.core_call(METHOD, json!({"workspace_id": workspace}), DEADLINE);
    match tokio::time::timeout(DEADLINE, call).await {
        Err(_) => Reply::NotAnswering(format!(
            "core did not answer within {} seconds",
            DEADLINE.as_secs()
        )),
        Ok(Err(refusal)) => match refusal.code.as_str() {
            "unknown_module" => Reply::NotAnswering("core is not installed".into()),
            "unavailable" => {
                Reply::NotAnswering(format!("core could not be reached: {}", refusal.message))
            }
            _ => Reply::Refused(Refusal::of(refusal)),
        },
        Ok(Ok(value)) => match decode(&value, workspace) {
            Ok(document) => Reply::Document(document),
            Err(reason) => Reply::NotAnswering(reason),
        },
    }
}

/// The guidance a run shows from core's `reply`, or why it shows none.
pub(crate) fn shown(reply: Reply) -> Result<String, String> {
    match reply {
        Reply::Document(Document::Served {
            root,
            audience,
            body,
            ..
        }) => {
            if !audience.iter().any(|role| role == HEAD) {
                return Err(format!(
                    "the guidance in {root} is not for head agents (its audience: {})",
                    if audience.is_empty() {
                        "none".to_owned()
                    } else {
                        audience.join(", ")
                    }
                ));
            }
            if body.trim().is_empty() {
                return Err(format!("the guidance in {root} is empty"));
            }
            if body.len() as u64 > MAX_PROJECT_DOC_BYTES {
                return Err(format!(
                    "the guidance in {root} is {} bytes, more than the {MAX_PROJECT_DOC_BYTES} a project document may hold",
                    body.len()
                ));
            }
            Ok(body)
        }
        Reply::Document(Document::NoRoot { workspace_id }) => {
            Err(format!("workspace {workspace_id} has no root folder"))
        }
        Reply::Document(Document::NoFile { root, .. }) => {
            Err(format!("the workspace's root folder {root} holds no guidance file"))
        }
        Reply::Document(Document::Refused {
            root,
            code,
            message,
            ..
        }) => Err(format!(
            "core refused the guidance file in {root} ({code}): {message}"
        )),
        Reply::Refused(Refusal::InvalidParams { message }) => Err(format!(
            "core refused the request (invalid_params): {message}"
        )),
        Reply::Refused(Refusal::UnknownWorkspace { message }) => Err(format!(
            "core knows no such workspace (unknown_workspace): {message}"
        )),
        Reply::Refused(Refusal::IndexUnavailable {
            message,
            retryable,
            retry_after_ms,
        }) => Err(format!(
            "core's workspace index is unavailable (workspace_index_unavailable{}{}): {message}; not asked again in this run",
            if retryable { ", retryable" } else { "" },
            retry_after_ms
                .map(|after| format!(" after {after} ms"))
                .unwrap_or_default()
        )),
        Reply::Refused(Refusal::Other { code, message }) => {
            Err(format!("core refused the request ({code}): {message}"))
        }
        Reply::NotAnswering(reason) => Err(reason),
    }
}

/// The guidance a run given `workspace` ([`super::task::TaskContext::workspace`])
/// shows, or why it shows none. Only a workspace of two or more projects
/// shares guidance; for a run without one core is not asked.
pub(crate) async fn for_run<C: RunnerClient>(
    client: &C,
    workspace: Option<&WorkspaceMembers>,
) -> Result<String, String> {
    let Some(workspace) = workspace.filter(|workspace| workspace.members.len() >= 2) else {
        return Err("the run has no workspace of two or more projects".into());
    };
    shown(read(client, &workspace.workspace_id).await)
}

/// The guidance a replay shows for `text`, as if core had served it to head
/// agents: the same rules as a run's, for a request written from a file.
#[cfg(test)]
pub(crate) fn served(text: &str) -> Result<String, String> {
    shown(Reply::Document(Document::Served {
        workspace_id: "(replay)".to_owned(),
        root: "(replay)".to_owned(),
        digest: String::new(),
        audience: vec![HEAD.to_owned()],
        body: text.to_owned(),
    }))
}

#[cfg(test)]
#[path = "guidance_tests.rs"]
mod tests;
