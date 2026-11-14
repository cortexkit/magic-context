//! The workspace level in the second turn: when the request carries the
//! workspace rule and shows the workspace's memories, and how a decision is
//! stored with and without it.

use serde_json::{json, Value};

use super::*;
use crate::memory_levels::Authority;
use crate::memory_writes::{self, SaveLevel, Writer};
use crate::summary::run::session_class_tests::Client;
use crate::workspace_members::tests::answer;

const PROJECT: &str = "project";
/// The second turn's child: the first turn's.
const CHILD: &str = "summary-child";

/// A writer authority as Entorhinal's context gives one for a project with
/// no domain (the bundled software profile), placed in `workspace`.
fn authority(workspace: Option<&str>) -> Authority {
    let records: Vec<Value> = serde_json::from_str(include_str!(
        "../../../testdata/entorhinal-memory-context-v1/context-project.json"
    ))
    .unwrap();
    let mut result = records[0]["reply"]["result"].clone();
    result["domain"] = Value::Null;
    let context = crate::memory_profile::resolve(
        &crate::memory_context::ContextAnswer::Answer(serde_json::from_value(result).unwrap()),
        &crate::memory_context::ContextAnswer::NotAnswering,
        &[],
    );
    let mut authority = Authority::from_context(&context).unwrap();
    authority.project_id = Some("pj-self".into());
    authority.workspace_id = workspace.map(str::to_owned);
    authority
}

fn job(authority: Option<Authority>) -> Job {
    Job {
        owner: SessionRef::new("runner", "pi", "head"),
        project: PROJECT.into(),
        project_root: Some("/project".into()),
        continuation: Continuation {
            prompts: crate::summary::prompts::SummaryPrompts::bundled(),
            keep_child: false,
            child: crate::client::Child {
                session: SessionRef::new("runner", "pi", CHILD),
                project_root: Some("/project".into()),
            },
            model: ModelRef::new("provider", "model"),
            decision_id: "decision".into(),
            output_tokens: 1_000,
            language: None,
            publication_id: "publication".into(),
        },
        memory_enabled: true,
        auto_promote: true,
        embedding: None,
        authority,
    }
}

/// A store with one committed publication holding one candidate fact (id
/// 1), a project memory and a memory of `workspace` that both share its
/// words. Returns the two memories' ids.
fn store(workspace: &str) -> (tempfile::TempDir, ContextDb, i64, i64) {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    db.with_connection(|conn| {
        conn.execute_batch(
            "INSERT INTO memory_publications(publication_id, project_path, source_session_id, commit_order, committed_at)
                 VALUES ('publication', 'project', 'head', 1, 0);
             INSERT INTO memory_pending_facts(project_path, publication_id, fact_index, category, content)
                 VALUES ('project', 'publication', 0, 'CONSTRAINTS', 'Releases need two reviewers.');",
        )
    })
    .unwrap();
    let authority = authority(Some(workspace));
    let who = Writer {
        harness: "pi",
        session: "head",
        project: PROJECT,
        authority: Some(&authority),
    };
    let save = |level, content: &str| {
        db.with_connection(|conn| memory_writes::save_at(conn, &who, level, "CONSTRAINTS", content))
            .unwrap()
            .memory_id
            .unwrap()
    };
    let own = save(
        SaveLevel::Project,
        "Releases need two reviewers before tagging.",
    );
    let shared = save(
        SaveLevel::Workspace,
        "Releases need two reviewers in every repository.",
    );
    (dir, db, own, shared)
}

/// Entorhinal's answer: `workspace`, named CortexKit, holding `projects`.
fn entorhinal(workspace: &str, projects: &[&str]) -> Value {
    let listed: Vec<(String, String)> = projects
        .iter()
        .enumerate()
        .map(|(index, name)| (format!("pj-{index}"), (*name).to_owned()))
        .collect();
    let projects: Vec<(&str, &str, Option<&str>, &str)> = listed
        .iter()
        .map(|(id, name)| (id.as_str(), name.as_str(), Some(workspace), "local"))
        .collect();
    answer(&[(workspace, "CortexKit")], &projects)
}

fn client(entorhinal: Option<Value>, reply: Option<Value>) -> Client {
    let mut client = Client::new(false);
    client.entorhinal = entorhinal;
    client.reply = reply.map(|reply| reply.to_string());
    client
}

/// The second turn's prompt as it was sent, and its stage's request.
fn sent(client: &Client, db: &ContextDb) -> (String, Value) {
    let sends = client.sends.lock().unwrap();
    let (_, request) = sends
        .iter()
        .find(|(child, _)| child.session.session == CHILD)
        .expect("a second turn was sent");
    let stored: String = db.with_connection(|conn| {
        conn.query_row(
            "SELECT request_json FROM memory_stage_attempts WHERE stage = 'turn_two'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    });
    (
        request.prompt.clone().expect("a prompt"),
        serde_json::from_str(&stored).unwrap(),
    )
}

/// The second turn's reply: `decision` for fact 1.
fn reply(decision: Value) -> Value {
    let mut decision = decision;
    decision["fact_id"] = json!(1);
    decision["check"] = json!("U settles it at [3]. Passes.");
    json!({"result": {"step": "turn_two", "decisions": [decision]}})
}

/// A request without the rule is the one sent before the workspace level
/// existed: a project in no workspace, a workspace of one project, and a
/// workspace Entorhinal says nothing about all send the same bytes, which
/// neither name the workspace nor show its memories.
#[tokio::test]
async fn without_a_workspace_of_several_projects_the_request_is_unchanged() {
    let send = |workspace: Option<&'static str>, entorhinal: Option<Value>| async move {
        let (_dir, db, _, _) = store(workspace.unwrap_or("ws-none"));
        let client = client(entorhinal, None);
        run(&client, &db, &job(Some(authority(workspace)))).await;
        sent(&client, &db)
    };
    let (plain, plain_request) = {
        let (_dir, db, _, _) = store("ws-none");
        let client = client(None, None);
        run(&client, &db, &job(None)).await;
        sent(&client, &db)
    };
    assert!(!plain.contains("(workspace)"), "{plain}");
    assert!(!plain.contains("\n6. "), "{plain}");
    assert!(plain_request.get("workspace").is_none());
    for (workspace, entorhinal) in [
        (None, None),
        (
            Some("ws-alone"),
            Some(entorhinal("ws-alone", &["magic-context"])),
        ),
        (Some("ws-quiet"), None),
    ] {
        let (prompt, request) = send(workspace, entorhinal).await;
        assert_eq!(prompt, plain, "{workspace:?}");
        assert_eq!(request, plain_request, "{workspace:?}");
    }
    // The same store in a workspace of two projects is sent the rule.
    let (prompt, _) = send(
        Some("ws-pair"),
        Some(entorhinal("ws-pair", &["magic-context", "subc"])),
    )
    .await;
    assert_ne!(prompt, plain);
}

#[tokio::test]
async fn a_workspace_of_several_projects_gets_the_rule_and_its_memories() {
    let (_dir, db, own, shared) = store("ws-multi");
    let client = client(
        Some(entorhinal(
            "ws-multi",
            &["subc", "entorhinal", "magic-context"],
        )),
        None,
    );
    run(&client, &db, &job(Some(authority(Some("ws-multi"))))).await;
    let (prompt, request) = sent(&client, &db);
    // The rule follows the decisions frame's last rule, its markers filled.
    assert!(
        prompt.contains(
            "Only that fact's neighbours are eligible targets.\n6. This project belongs to the workspace CortexKit, which holds 3 projects: entorhinal, magic-context, subc. "
        ),
        "{prompt}"
    );
    assert!(!prompt.contains('\u{27e6}'), "{prompt}");
    // Both memories are neighbours; only the workspace's is marked.
    assert!(prompt.contains(&format!(
        "- #{own} rev 1 [CONSTRAINTS]\n  c1: Releases need two reviewers before tagging."
    )));
    assert!(prompt.contains(&format!(
        "- #{shared} rev 1 [CONSTRAINTS] (workspace)\n  c1: Releases need two reviewers in every repository."
    )));
    assert_eq!(request["workspace"], json!("ws-multi"));
}

/// A stored memory's level, owner, source project and text.
fn memory(db: &ContextDb, id: i64) -> (String, String, Option<String>, String) {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT level, owner_id, source_project_id, content FROM memories WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap()
    })
}

/// The fact's state, reason and the memory it resolved to.
fn fact(db: &ContextDb) -> (String, String, Option<i64>) {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT state, reason, matched_memory_id FROM memory_pending_facts WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    })
}

#[tokio::test]
async fn a_new_memory_for_the_workspace_is_owned_by_it_with_this_project_as_source() {
    let (_dir, db, _, _) = store("ws-new");
    let client = client(
        Some(entorhinal("ws-new", &["magic-context", "subc"])),
        Some(reply(json!({"action": "new", "level": "workspace"}))),
    );
    run(&client, &db, &job(Some(authority(Some("ws-new"))))).await;
    let (state, reason, id) = fact(&db);
    assert_eq!((state.as_str(), reason.as_str()), ("applied", "inserted"));
    let id = id.unwrap();
    assert_eq!(
        memory(&db, id),
        (
            "workspace".into(),
            "ws-new".into(),
            Some(PROJECT.into()),
            "Releases need two reviewers.".into()
        )
    );
    // Its history row names the summary run: the decision's stage, which is
    // the publication's second turn.
    let key: String = db.with_connection(|conn| {
        conn.query_row(
            "SELECT decision_key FROM memory_history WHERE memory_id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap()
    });
    let key: Value = serde_json::from_str(&key).unwrap();
    assert_eq!(
        key[5],
        json!(json!([PROJECT, "publication", 1, "turn_two"]).to_string())
    );
}

#[tokio::test]
async fn without_the_rule_a_new_memory_asking_for_the_workspace_stays_with_the_project() {
    let (_dir, db, _, _) = store("ws-single");
    let client = client(
        Some(entorhinal("ws-single", &["magic-context"])),
        Some(reply(json!({"action": "new", "level": "workspace"}))),
    );
    run(&client, &db, &job(Some(authority(Some("ws-single"))))).await;
    let (state, _, id) = fact(&db);
    assert_eq!(state, "applied");
    let (level, owner, ..) = memory(&db, id.unwrap());
    assert_eq!((level.as_str(), owner.as_str()), ("project", PROJECT));
}

#[tokio::test]
async fn an_unknown_level_is_an_invalid_decision() {
    let (_dir, db, _, _) = store("ws-invalid");
    let client = client(
        Some(entorhinal("ws-invalid", &["magic-context", "subc"])),
        Some(reply(json!({"action": "new", "level": "team"}))),
    );
    run(&client, &db, &job(Some(authority(Some("ws-invalid"))))).await;
    assert_eq!(
        fact(&db),
        ("decided_pending".into(), "malformed_decision".into(), None)
    );
    let historian: i64 = db.with_connection(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE source_type = 'historian'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    });
    assert_eq!(historian, 0);
}

#[test]
fn level_belongs_to_new_and_names_the_project_or_the_workspace() {
    let parsed = |decision: Value| {
        let text = reply(decision).to_string();
        let envelope = envelope::parse(&text, false, false).unwrap();
        match &envelope.decisions[&1] {
            Entry::Decision(decision) => Some(decision.level.clone()),
            Entry::Malformed => None,
        }
    };
    assert_eq!(parsed(json!({"action": "new"})), Some(None));
    assert_eq!(
        parsed(json!({"action": "new", "level": "project"})),
        Some(Some("project".into()))
    );
    assert_eq!(
        parsed(json!({"action": "new", "level": "workspace"})),
        Some(Some("workspace".into()))
    );
    assert_eq!(parsed(json!({"action": "new", "level": "global"})), None);
    assert_eq!(parsed(json!({"action": "new", "level": true})), None);
    assert_eq!(
        parsed(json!({"action": "abstain", "level": "workspace"})),
        None
    );
}

#[tokio::test]
async fn a_merge_of_memories_at_different_levels_is_refused() {
    let (_dir, db, own, shared) = store("ws-merge");
    let client = client(
        Some(entorhinal("ws-merge", &["magic-context", "subc"])),
        Some(reply(json!({
            "action": "merge",
            "sources": [{"id": own, "revision": 1}, {"id": shared, "revision": 1}],
            "survivor_id": own,
            "kept": [{"memory_id": own, "clause": 1}],
            "removed": [{"memory_id": shared, "clause": 1, "block": 1, "excerpt": "every repository"}],
            "final_text": "Releases need two reviewers before tagging.",
        }))),
    );
    run(&client, &db, &job(Some(authority(Some("ws-merge"))))).await;
    assert_eq!(
        fact(&db),
        ("decided_pending".into(), "merge_mixed_levels".into(), None)
    );
    // Nothing was merged or archived, and no check was sent.
    let rows: Vec<(i64, String, i64)> = db.with_connection(|conn| {
        conn.prepare("SELECT id, status, revision FROM memories ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    });
    assert_eq!(
        rows,
        [(own, "active".into(), 1), (shared, "active".into(), 1)]
    );
    assert_eq!(client.sends.lock().unwrap().len(), 1);
}

#[test]
fn a_source_is_in_scope_at_its_own_level() {
    let source = |level: &str, owner: &str| gates::Source {
        id: 1,
        revision: 1,
        level: level.into(),
        owner: owner.into(),
        status: "active".into(),
        content: String::new(),
    };
    assert!(gates::in_scope(&source("project", "p"), "p", None));
    assert!(!gates::in_scope(&source("project", "q"), "p", Some("w")));
    assert!(gates::in_scope(&source("workspace", "w"), "p", Some("w")));
    assert!(!gates::in_scope(&source("workspace", "w"), "p", None));
    assert!(!gates::in_scope(&source("workspace", "v"), "p", Some("w")));
    assert!(!gates::in_scope(&source("global", "p"), "p", Some("w")));
    assert!(gates::mixed_levels(&[
        source("project", "p"),
        source("workspace", "w")
    ]));
    assert!(!gates::mixed_levels(&[
        source("workspace", "w"),
        source("workspace", "w")
    ]));
}

/// An edit or a replacement of a workspace memory keeps it at the
/// workspace, owned by the workspace; without the workspace in scope the
/// memory isn't the decision's to change.
#[test]
fn a_revised_workspace_memory_stays_at_the_workspace() {
    let (_dir, db, _, shared) = store("ws-edit");
    let revision = |key: &str, action: &str, workspace: Option<&str>, read: i64| Revision {
        key: key.into(),
        action: action.into(),
        project: PROJECT.into(),
        workspace: workspace.map(str::to_owned),
        expected: vec![(shared, read)],
        survivor: shared,
        final_text: format!("Releases need two reviewers, revised by {key}."),
        changes: Vec::new(),
        added: Vec::new(),
        expires: None,
    };
    let plan = gates::Plan {
        checks: Vec::new(),
        kept: Vec::new(),
        spans: Vec::new(),
    };
    let authority = authority(Some("ws-edit"));
    let commit = |revision: &Revision| {
        db.with_connection(|conn| {
            applier::commit_revision(conn, revision, &plan, 1, None, Some(&authority))
        })
        .unwrap()
    };
    // Out of scope: the request showed no workspace.
    let refused = commit(&revision("outside", "edit", None, 1));
    assert_eq!(
        (refused.state.as_str(), refused.reason.as_str()),
        ("retryable", "cas_loss")
    );
    let edited = commit(&revision("edit", "edit", Some("ws-edit"), 1));
    assert_eq!(edited.state, "applied");
    assert_eq!(edited.memory_id, Some(shared));
    let (level, owner, _, content) = memory(&db, shared);
    assert_eq!(
        (level.as_str(), owner.as_str(), content.as_str()),
        (
            "workspace",
            "ws-edit",
            "Releases need two reviewers, revised by edit."
        )
    );
    let replaced = commit(&revision("replace", "replaces", Some("ws-edit"), 2));
    assert_eq!(replaced.state, "applied");
    let successor = replaced.memory_id.unwrap();
    assert_ne!(successor, shared);
    assert_eq!(
        memory(&db, successor),
        (
            "workspace".into(),
            "ws-edit".into(),
            Some(PROJECT.into()),
            "Releases need two reviewers, revised by replace.".into()
        )
    );
}
