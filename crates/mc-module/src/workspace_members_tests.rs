//! Reading a workspace's projects from a stand-in Entorhinal.

use serde_json::{json, Value};

use super::*;
use crate::summary::run::session_class_tests::Client;

/// An `enumerate` answer listing `workspaces` (id, name) and `projects`
/// (id, name, workspace id, reference kind).
pub(crate) fn answer(
    workspaces: &[(&str, &str)],
    projects: &[(&str, &str, Option<&str>, &str)],
) -> Value {
    json!({"result": {
        "workspaces": workspaces.iter().map(|(id, name)| json!({"workspaceId": id, "name": name, "root": null})).collect::<Vec<_>>(),
        "projects": projects.iter().map(|(id, name, workspace, kind)| {
            let mut project = json!({"projectId": id, "name": name, "roots": [], "implicit": false, "refKind": kind});
            if let Some(workspace) = workspace {
                project["workspaceId"] = json!(workspace);
            }
            project
        }).collect::<Vec<_>>(),
        "generation": 1,
        "incarnation": "inc-1",
    }})
}

fn client(reply: Option<Value>) -> Client {
    let mut client = Client::new(false);
    client.entorhinal = reply;
    client
}

#[tokio::test]
async fn a_workspace_lists_its_local_projects_by_name() {
    let client = client(Some(answer(
        &[("ws-list", "CortexKit"), ("ws-other", "Other")],
        &[
            ("pj-c", "subc", Some("ws-list"), "local"),
            ("pj-a", "magic-context", Some("ws-list"), "local"),
            ("pj-b", "entorhinal", Some("ws-list"), "local"),
            // Another machine's project, another workspace's, and one in none.
            ("rf-d", "remote", Some("ws-list"), "remote"),
            ("pj-e", "elsewhere", Some("ws-other"), "local"),
            ("pj-f", "alone", None, "local"),
        ],
    )));
    let Lookup::Members(members) = workspace_members(&client, "ws-list").await else {
        panic!("no members");
    };
    assert_eq!(members.workspace_id, "ws-list");
    assert_eq!(members.name, "CortexKit");
    let names: Vec<(&str, &str)> = members
        .members
        .iter()
        .map(|member| (member.project_id.as_str(), member.name.as_str()))
        .collect();
    assert_eq!(
        names,
        [
            ("pj-b", "entorhinal"),
            ("pj-a", "magic-context"),
            ("pj-c", "subc")
        ]
    );
    // The read names the workspace.
    assert_eq!(
        *client.entorhinal_calls.lock().unwrap(),
        [json!({"method": "enumerate", "params": {"workspaceId": "ws-list"}})]
    );
}

#[tokio::test]
async fn an_answer_is_used_again_and_entorhinal_is_not_asked_twice() {
    let client = client(Some(answer(
        &[("ws-again", "Again")],
        &[("pj-a", "a", Some("ws-again"), "local")],
    )));
    let first = workspace_members(&client, "ws-again").await;
    let second = workspace_members(&client, "ws-again").await;
    assert_eq!(first, second);
    assert_eq!(client.entorhinal_calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn no_answer_is_its_own_outcome_and_is_not_asked_again_at_once() {
    let client = client(None);
    assert_eq!(
        workspace_members(&client, "ws-silent").await,
        Lookup::NotAnswering
    );
    assert_eq!(
        workspace_members(&client, "ws-silent").await,
        Lookup::NotAnswering
    );
    assert_eq!(client.entorhinal_calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_workspace_entorhinal_does_not_list_is_unknown() {
    let client = client(Some(answer(&[("ws-else", "Else")], &[])));
    assert_eq!(
        workspace_members(&client, "ws-unlisted").await,
        Lookup::Unknown
    );
    // A refusal is no answer.
    let refused = client_refusal();
    assert_eq!(
        workspace_members(&refused, "ws-refused").await,
        Lookup::NotAnswering
    );
}

fn client_refusal() -> Client {
    client(Some(
        json!({"code": "store_unavailable", "message": "no store"}),
    ))
}
