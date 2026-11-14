//! Core's `persona.workspace_document` replies, from its own samples, and
//! what a curate run shows for each: the guidance, or one reason why not.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::*;
use crate::client::CoreRefusal;
use crate::dreamer::run::tests::Client;
use crate::workspace_members::{Member, WorkspaceMembers};

/// Core's real handler's replies, copied byte for byte from the prefrontal
/// repository's `test-vectors/workspace-document-v1/` (commit
/// `26b50d2c03`), with the checksums it publishes for them.
const SAMPLES: &[(&str, &str)] = &[
    (
        "no_file.json",
        include_str!("../../testdata/workspace-document-v1/no_file.json"),
    ),
    (
        "no_root.json",
        include_str!("../../testdata/workspace-document-v1/no_root.json"),
    ),
    (
        "refused.json",
        include_str!("../../testdata/workspace-document-v1/refused.json"),
    ),
    (
        "served.json",
        include_str!("../../testdata/workspace-document-v1/served.json"),
    ),
];
const SUMS: &str = include_str!("../../testdata/workspace-document-v1/SHA256SUMS");

fn sample(name: &str) -> Value {
    let (_, text) = SAMPLES
        .iter()
        .find(|(file, _)| *file == name)
        .unwrap_or_else(|| panic!("no sample {name}"));
    serde_json::from_str(text).unwrap()
}

/// The workspace a sample asks about, and core's reply to it.
fn asked(name: &str) -> (String, Value) {
    let sample = sample(name);
    (
        sample["request"]["params"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_owned(),
        sample["reply"].clone(),
    )
}

/// A test client whose core answers every call with `answer`, or is not
/// installed when `answer` is `None`.
fn client(answer: Option<Result<Value, CoreRefusal>>) -> Client {
    let mut client = Client::new(&[], &[]);
    client.core = answer;
    client
}

fn refusal(code: &str, message: &str, detail: Option<Value>) -> CoreRefusal {
    CoreRefusal {
        code: code.into(),
        message: message.into(),
        detail,
    }
}

/// A workspace of `count` projects.
fn workspace(id: &str, count: usize) -> WorkspaceMembers {
    WorkspaceMembers {
        workspace_id: id.into(),
        name: "CortexKit".into(),
        members: (0..count)
            .map(|index| Member {
                project_id: format!("pj-{index}"),
                name: format!("project {index}"),
            })
            .collect(),
    }
}

/// What a run given `workspace` (a workspace of two projects) shows when
/// core answers `answer`, and the calls it made to core.
async fn run_shows(
    workspace_id: &str,
    answer: Option<Result<Value, CoreRefusal>>,
) -> (Result<String, String>, Vec<(String, Value)>) {
    let client = client(answer);
    let shown = for_run(&client, Some(&workspace(workspace_id, 2))).await;
    let calls = client.core_calls.lock().unwrap().clone();
    (shown, calls)
}

#[test]
fn the_samples_are_the_bytes_core_published() {
    let mut listed = 0;
    for line in SUMS.lines() {
        let (sum, name) = line.split_once("  ").unwrap();
        let (_, text) = SAMPLES
            .iter()
            .find(|(file, _)| *file == name)
            .unwrap_or_else(|| panic!("SHA256SUMS lists {name}, which is not loaded"));
        let digest: String = Sha256::digest(text.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(digest, sum, "{name}");
        listed += 1;
    }
    assert_eq!(listed, SAMPLES.len());
    // Each is the request this module sends, on the route it uses.
    for (name, _) in SAMPLES {
        let sample = sample(name);
        assert_eq!(sample["request"]["method"], METHOD, "{name}");
        assert_eq!(
            sample["route"],
            json!({"principal": "reserved:magic-context", "surface": "management"}),
            "{name}"
        );
    }
}

#[test]
fn every_sample_decodes_into_its_state() {
    let decoded = |name: &str| {
        let (workspace, reply) = asked(name);
        decode(&reply, &workspace).unwrap_or_else(|error| panic!("{name}: {error}"))
    };
    assert_eq!(
        decoded("served.json"),
        Document::Served {
            workspace_id: "ws_served".into(),
            root: "/workspace/served".into(),
            digest: "7d6be4aee51113448d69c54466c66d85ebab93ac00fe59ca01b3c3542d6d4460".into(),
            audience: ["athena", "head", "mason", "oneshot", "sidekick", "spec"]
                .map(String::from)
                .to_vec(),
            body: "# Shared guidance\n\nKeep the workspace rules.".into(),
        }
    );
    assert_eq!(
        decoded("no_root.json"),
        Document::NoRoot {
            workspace_id: "ws_no_root".into()
        }
    );
    assert_eq!(
        decoded("no_file.json"),
        Document::NoFile {
            workspace_id: "ws_no_file".into(),
            root: "/workspace/no_file".into()
        }
    );
    assert_eq!(
        decoded("refused.json"),
        Document::Refused {
            workspace_id: "ws_refused".into(),
            root: "/workspace/refused".into(),
            code: "workspace_prompt_missing_front_matter".into(),
            message: "file must open with `---` front matter declaring `audience`".into(),
        }
    );
}

#[test]
fn members_a_later_core_adds_are_ignored() {
    let (workspace, mut reply) = asked("served.json");
    reply["result"]["etag"] = json!("v2");
    reply["result"]["sections"] = json!([{"id": "rules"}]);
    reply["served_at_ms"] = json!(1);
    assert!(matches!(
        decode(&reply, &workspace),
        Ok(Document::Served { .. })
    ));
    let (workspace, mut reply) = asked("no_root.json");
    reply["result"]["hint"] = json!("set a root");
    assert!(matches!(
        decode(&reply, &workspace),
        Ok(Document::NoRoot { .. })
    ));
}

#[test]
fn an_answer_that_does_not_decode_or_names_another_workspace_is_no_answer() {
    let (_, reply) = asked("served.json");
    assert_eq!(
        decode(&reply, "ws_other"),
        Err("core answered for workspace ws_served instead of ws_other".into())
    );
    assert_eq!(
        decode(&json!({"ok": true}), "ws_served"),
        Err("core's answer holds no result".into())
    );
    let unknown = decode(
        &json!({"result": {"state": "moved", "workspace_id": "ws_served"}}),
        "ws_served",
    );
    assert!(
        unknown
            .as_ref()
            .is_err_and(|error| error.starts_with("core's answer doesn't decode")),
        "{unknown:?}"
    );
}

#[tokio::test]
async fn served_guidance_for_head_agents_is_shown_as_core_serves_it() {
    let (workspace, reply) = asked("served.json");
    let (shown, calls) = run_shows(&workspace, Some(Ok(reply))).await;
    assert_eq!(
        shown,
        Ok("# Shared guidance\n\nKeep the workspace rules.".into())
    );
    // One call, for the run's workspace.
    assert_eq!(
        calls,
        [(METHOD.to_owned(), json!({"workspace_id": "ws_served"}))]
    );
}

#[tokio::test]
async fn guidance_whose_audience_has_no_head_agents_is_not_shown() {
    let (workspace, mut reply) = asked("served.json");
    reply["result"]["audience"] = json!(["mason", "sidekick"]);
    let (shown, _) = run_shows(&workspace, Some(Ok(reply.clone()))).await;
    assert_eq!(
        shown,
        Err(
            "the guidance in /workspace/served is not for head agents (its audience: mason, sidekick)"
                .into()
        )
    );
    reply["result"]["audience"] = json!([]);
    let (shown, _) = run_shows(&workspace, Some(Ok(reply))).await;
    assert_eq!(
        shown,
        Err("the guidance in /workspace/served is not for head agents (its audience: none)".into())
    );
}

#[tokio::test]
async fn every_other_state_says_why_no_guidance_is_shown() {
    for (name, why) in [
        ("no_root.json", "workspace ws_no_root has no root folder"),
        (
            "no_file.json",
            "the workspace's root folder /workspace/no_file holds no guidance file",
        ),
        (
            "refused.json",
            "core refused the guidance file in /workspace/refused (workspace_prompt_missing_front_matter): file must open with `---` front matter declaring `audience`",
        ),
    ] {
        let (workspace, reply) = asked(name);
        let (shown, calls) = run_shows(&workspace, Some(Ok(reply))).await;
        assert_eq!(shown, Err(why.into()), "{name}");
        assert_eq!(calls.len(), 1, "{name}");
    }
}

#[tokio::test]
async fn every_refusal_says_why_no_guidance_is_shown_and_none_is_asked_again() {
    for (answer, why) in [
        (
            refusal("invalid_params", "workspace_id must be a string", None),
            "core refused the request (invalid_params): workspace_id must be a string",
        ),
        (
            refusal("unknown_workspace", "no workspace ws-a", None),
            "core knows no such workspace (unknown_workspace): no workspace ws-a",
        ),
        (
            refusal(
                "workspace_index_unavailable",
                "the workspace index is rebuilding",
                Some(json!({"retryable": true, "retry_after_ms": 60000})),
            ),
            "core's workspace index is unavailable (workspace_index_unavailable, retryable after 60000 ms): the workspace index is rebuilding; not asked again in this run",
        ),
        (
            refusal("forbidden", "magic-context may not read this", None),
            "core refused the request (forbidden): magic-context may not read this",
        ),
        (
            CoreRefusal::unavailable("connection reset"),
            "core could not be reached: connection reset",
        ),
    ] {
        let (shown, calls) = run_shows("ws-a", Some(Err(answer.clone()))).await;
        assert_eq!(shown, Err(why.into()), "{answer:?}");
        // A retryable refusal is not retried within the run.
        assert_eq!(calls.len(), 1, "{answer:?}");
    }
    // A core that is not installed.
    let (shown, calls) = run_shows("ws-a", None).await;
    assert_eq!(shown, Err("core is not installed".into()));
    assert_eq!(calls.len(), 1);
    // The transport's own refusal for a module the daemon doesn't have.
    let (shown, _) = run_shows("ws-a", Some(Err(CoreRefusal::not_installed()))).await;
    assert_eq!(shown, Err("core is not installed".into()));
}

#[tokio::test]
async fn a_run_without_a_workspace_of_two_projects_asks_core_nothing() {
    let (_, reply) = asked("served.json");
    for given in [None, Some(workspace("ws_served", 1))] {
        let client = client(Some(Ok(reply.clone())));
        assert_eq!(
            for_run(&client, given.as_ref()).await,
            Err("the run has no workspace of two or more projects".into())
        );
        assert!(client.core_calls.lock().unwrap().is_empty());
    }
}

#[test]
fn guidance_longer_than_a_project_document_is_left_out_whole() {
    let limit = MAX_PROJECT_DOC_BYTES as usize;
    // Exactly the limit fits, as a project document of that size does.
    let fits = format!("{}\n", "a".repeat(limit - 1));
    assert_eq!(served(&fits), Ok(fits.clone()));
    let over = format!("{fits}b");
    assert_eq!(
        served(&over),
        Err(format!(
            "the guidance in (replay) is {} bytes, more than the {limit} a project document may hold",
            limit + 1
        ))
    );
    // Guidance with no text shows nothing.
    assert_eq!(
        served(" \n\n"),
        Err("the guidance in (replay) is empty".into())
    );
}
