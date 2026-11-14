//! The engine and the workspace's shared memories: one curate schedule per
//! workspace of two or more projects, run in a member project's folder;
//! project curate given its workspace; the lift's two locks, workspace
//! first; and the curate due half an hour after a lift that moved memories.

use std::sync::Arc;

use serde_json::{json, Value};

use super::*;
use crate::dreamer::run::tests::{Client, Ends};
use crate::dreamer::tasks::curate::Curate;
use crate::dreamer::tasks::curate_workspace::tests::{insert, personal, rule, Row};
use crate::dreamer::tasks::curate_workspace::CurateWorkspace;
use crate::dreamer::tasks::lift_workspace::LiftWorkspace;
use crate::workspace_members::tests::answer;

/// The bundled profile, with the lift switched on.
fn profile() -> Arc<Profile> {
    let mut profile = crate::memory_profile::prompt_profile(None).unwrap();
    for task in profile.body["tasks"].as_array_mut().unwrap() {
        if task["id"] == "swe:lift-workspace" {
            task["enabled"] = json!(true);
        }
    }
    Arc::new(profile)
}

/// Entorhinal's answer listing `workspace` with projects `pj-<name>` named
/// `names`.
fn listing(workspace: &str, names: &[&str]) -> Value {
    let projects: Vec<(String, String)> = names
        .iter()
        .map(|name| (format!("pj-{name}"), (*name).to_owned()))
        .collect();
    answer(
        &[(workspace, "CortexKit")],
        &projects
            .iter()
            .map(|(id, name)| (id.as_str(), name.as_str(), Some(workspace), "local"))
            .collect::<Vec<_>>(),
    )
}

fn client(entorhinal: Option<Value>, ends: &[Ends]) -> Arc<Client> {
    let mut client = Client::new(&["p/a"], ends);
    client.entorhinal = entorhinal;
    Arc::new(client)
}

fn store() -> (tempfile::TempDir, Arc<ContextDb>) {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    (dir, Arc::new(db))
}

/// An engine running `tasks` that has seen each of `projects` (by name,
/// as `pj-<name>` in `/work/pj-<name>`) in `workspace`.
fn engine(
    db: &ContextDb,
    tasks: Vec<Box<dyn Task>>,
    workspace: &str,
    projects: &[&str],
) -> Arc<Engine> {
    let engine = Arc::new(Engine::new("this", tasks));
    for name in projects {
        see(&engine, db, workspace, name);
    }
    engine
}

fn see(engine: &Engine, db: &ContextDb, workspace: &str, name: &str) {
    let project = format!("pj-{name}");
    engine.see_project(
        db,
        &project,
        &format!("/work/{project}"),
        profile(),
        &Settings::default(),
        now_ms(),
    );
    engine.see_workspace(&project, Some(workspace));
}

/// Wait until no run is in progress and no workspace is being checked.
async fn settled(engine: &Engine) {
    for _ in 0..500 {
        if engine.running.lock().unwrap().is_empty() && engine.checking.lock().unwrap().is_empty() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the round never ended");
}

async fn round(engine: &Arc<Engine>, db: &Arc<ContextDb>, client: &Arc<Client>) {
    engine.tick(db, client, &Settings::default(), now_ms());
    settled(engine).await;
}

/// Every schedule row: level, owner, task and schedule.
fn schedules(db: &ContextDb) -> Vec<(String, String, String, String)> {
    db.with_connection(|conn| {
        conn.prepare(
            "SELECT level, owner_id, task, schedule FROM dream_schedules ORDER BY level, owner_id, task",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    })
}

fn row(level: &str, owner: &str, task: &str) -> (String, String, String, String) {
    (level.into(), owner.into(), task.into(), "0 4 * * 0".into())
}

/// Each run's task, kind, level, owner and outcome.
fn runs(db: &ContextDb) -> Vec<(String, String, String, String, Option<String>)> {
    db.with_connection(|conn| {
        conn.prepare("SELECT task, kind, level, owner_id, outcome FROM dream_task_runs ORDER BY id")
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    })
}

/// Each lock row: level, owner and holder.
fn locks(db: &ContextDb) -> Vec<(String, String, String)> {
    db.with_connection(|conn| {
        conn.prepare("SELECT level, owner_id, holder FROM dream_locks ORDER BY rowid")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    })
}

fn due_at(db: &ContextDb, owner: &OwnerKey, task: &str) -> Option<i64> {
    db.with_connection(|conn| store::schedule_of(conn, owner, task))
        .unwrap()
        .map(|schedule| schedule.next_due_at)
}

fn make_due(db: &ContextDb, owner: &OwnerKey, task: &str) {
    assert!(db
        .with_connection(|conn| store::due_at(conn, owner, task, now_ms() - 1))
        .unwrap());
}

fn sent(client: &Client) -> Vec<String> {
    client
        .sends
        .lock()
        .unwrap()
        .iter()
        .map(|(_, request)| serde_json::to_string(request).unwrap())
        .collect()
}

#[tokio::test]
async fn a_shared_workspace_gets_one_curate_schedule_and_its_projects_none() {
    let (_dir, db) = store();
    let tasks: Vec<Box<dyn Task>> = vec![Box::new(Curate), Box::new(CurateWorkspace)];
    let engine = engine(&db, tasks, "ws-cw-schedule", &["magic-context", "subc"]);
    let client = client(
        Some(listing("ws-cw-schedule", &["magic-context", "subc"])),
        &[],
    );
    round(&engine, &db, &client).await;
    assert_eq!(
        schedules(&db),
        [
            row("project", "pj-magic-context", "swe:curate"),
            row("project", "pj-subc", "swe:curate"),
            row("workspace", "ws-cw-schedule", "swe:curate-workspace"),
        ]
    );
    // Its first slot is still to come: nothing ran.
    assert!(runs(&db).is_empty());
    assert!(client.sends.lock().unwrap().is_empty());
    // The person's setting for the kind is the workspace's schedule.
    let mut settings = Settings::default();
    settings
        .schedules
        .insert("curate-workspace".into(), "0 5 * * *".into());
    engine.tick(&db, &client, &settings, now_ms());
    settled(&engine).await;
    let owner = OwnerKey::workspace("ws-cw-schedule");
    let schedule = db
        .with_connection(|conn| store::schedule_of(conn, &owner, "swe:curate-workspace"))
        .unwrap()
        .unwrap();
    assert_eq!(schedule.schedule, "0 5 * * *");
}

#[tokio::test]
async fn a_workspace_of_one_project_or_without_an_answer_gets_no_schedule() {
    let (_dir, db) = store();
    let tasks = || -> Vec<Box<dyn Task>> { vec![Box::new(CurateWorkspace)] };
    let engine_one = engine(&db, tasks(), "ws-cw-solo", &["magic-context"]);
    let client_one = client(Some(listing("ws-cw-solo", &["magic-context"])), &[]);
    round(&engine_one, &db, &client_one).await;
    let engine_silent = engine(&db, tasks(), "ws-cw-silent", &["magic-context", "subc"]);
    let client_silent = client(None, &[]);
    round(&engine_silent, &db, &client_silent).await;
    assert!(schedules(&db).is_empty(), "{:?}", schedules(&db));
}

#[tokio::test]
async fn a_due_workspace_curate_runs_in_a_member_projects_folder_and_writes_the_workspace() {
    let (_dir, db) = store();
    let workspace = "ws-cw-run";
    insert(
        &db,
        &[
            Row {
                owner: workspace.into(),
                ..rule(1, "Run `cargo fmt --all` before every commit.")
            },
            Row {
                owner: workspace.into(),
                source_project: Some("pj-b"),
                ..rule(2, "Before committing, run `cargo fmt --all`.")
            },
            personal(30, "Always answer the person in English."),
        ],
    );
    let tasks: Vec<Box<dyn Task>> = vec![Box::new(CurateWorkspace)];
    let engine = engine(&db, tasks, workspace, &["subc", "magic-context"]);
    let client = client(
        Some(listing(workspace, &["subc", "magic-context"])),
        &[
            Ends::Reply("<curate>\n<archive id=\"2\" reason=\"duplicate\" of=\"1\"/>\n</curate>"),
            Ends::Reply("<curate></curate>"),
        ],
    );
    round(&engine, &db, &client).await;
    let owner = OwnerKey::workspace(workspace);
    make_due(&db, &owner, "swe:curate-workspace");
    round(&engine, &db, &client).await;

    assert_eq!(
        runs(&db),
        [(
            "swe:curate-workspace".into(),
            "curate-workspace".into(),
            "workspace".into(),
            workspace.into(),
            Some("applied".into())
        )]
    );
    // One message per category with memories: the rules only. It runs in
    // the folder of the first member project seen here, by id.
    let sends = client.sends.lock().unwrap().clone();
    assert_eq!(sends.len(), 1);
    assert_eq!(
        sends[0].0.project_root.as_deref(),
        Some("/work/pj-magic-context")
    );
    let message = serde_json::to_string(&sends[0].1).unwrap();
    assert!(message.contains("CortexKit, with 2 projects: magic-context, subc"));
    assert!(message.contains("[30] COMMUNICATION: Always answer the person in English."));
    let archived: (String, Option<i64>) = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT status, superseded_by_memory_id FROM memories WHERE id = 2",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!(archived, ("archived".into(), Some(1)));
    // The run settled the workspace's schedule onto its next slot and let
    // the workspace's lock go.
    assert!(due_at(&db, &owner, "swe:curate-workspace").unwrap() > now_ms());
    assert!(locks(&db).is_empty());
}

#[tokio::test]
async fn a_project_curate_is_given_its_shared_workspace() {
    let (_dir, db) = store();
    let workspace = "ws-cw-project";
    insert(
        &db,
        &[
            Row {
                level: "project",
                owner: "pj-magic-context".into(),
                ..rule(1, "Run the gate script before delivering a change.")
            },
            Row {
                owner: workspace.into(),
                ..rule(40, "Use the gate script before delivering a change.")
            },
        ],
    );
    let tasks: Vec<Box<dyn Task>> = vec![Box::new(Curate)];
    let engine = engine(&db, tasks, workspace, &["magic-context"]);
    let client = client(
        Some(listing(workspace, &["magic-context", "subc"])),
        &[Ends::Reply("<curate></curate>")],
    );
    make_due(&db, &OwnerKey::project("pj-magic-context"), "swe:curate");
    round(&engine, &db, &client).await;
    let sent = sent(&client);
    assert_eq!(sent.len(), 1);
    assert!(sent[0].contains("[40] PROJECT_RULES: Use the gate script before delivering a change."));
}

/// The guidance core serves in the curate tests.
const GUIDANCE: &str = "# CortexKit\n\n- Deliver every change through the gate script.";

/// Core's reply serving `GUIDANCE` for `workspace` to `audience`.
fn served(workspace: &str, audience: &[&str]) -> Value {
    json!({"result": {
        "state": "served",
        "workspace_id": workspace,
        "root": "/work/cortexkit",
        "digest": "7d6be4aee51113448d69c54466c66d85ebab93ac00fe59ca01b3c3542d6d4460",
        "audience": audience,
        "body": GUIDANCE,
    }})
}

/// `text` as it appears inside a sent request's JSON.
fn in_json(text: &str) -> String {
    let quoted = serde_json::to_string(text).unwrap();
    quoted[1..quoted.len() - 1].to_owned()
}

/// A project curate run of `pj-magic-context` in a workspace of two
/// projects, with core answering `core`: the message it sent, its run's
/// outcome, every call to core, and the lines it logged.
async fn project_curate_with(
    workspace: &str,
    core: Option<Result<Value, crate::client::CoreRefusal>>,
) -> (String, Option<String>, Vec<(String, Value)>, String) {
    let (_dir, db) = store();
    insert(
        &db,
        &[Row {
            level: "project",
            owner: "pj-magic-context".into(),
            ..rule(1, "Run the gate script before delivering a change.")
        }],
    );
    let engine = engine(&db, vec![Box::new(Curate)], workspace, &["magic-context"]);
    let mut client = Client::new(&["p/a"], &[Ends::Reply("<curate></curate>")]);
    client.entorhinal = Some(listing(workspace, &["magic-context", "subc"]));
    client.core = core;
    let client = Arc::new(client);
    make_due(&db, &OwnerKey::project("pj-magic-context"), "swe:curate");
    let capture = crate::test_log::capture();
    round(&engine, &db, &client).await;
    let log = capture.text();
    let sent = sent(&client);
    assert_eq!(sent.len(), 1);
    let outcome = runs(&db).pop().and_then(|run| run.4);
    let calls = client.core_calls.lock().unwrap().clone();
    (sent[0].clone(), outcome, calls, log)
}

#[tokio::test]
async fn a_project_curate_shows_the_guidance_core_serves_its_workspace() {
    let workspace = "ws-guidance-project";
    let (sent, outcome, calls, log) =
        project_curate_with(workspace, Some(Ok(served(workspace, &["head", "mason"])))).await;
    // The project has no documents and every session sees no other memory,
    // so the guidance block is followed by the part.
    assert!(sent.contains(&in_json(&format!(
        "<workspace-guidance>\nEvery agent in this project's workspace reads this at the start of every session.\n{GUIDANCE}\n</workspace-guidance>\n\n<memories part=\"1 of 1\">"
    ))));
    assert_eq!(outcome.as_deref(), Some("nothing_to_do"));
    // Asked once, for the project's workspace.
    assert_eq!(
        calls,
        [(
            "persona.workspace_document".to_owned(),
            json!({"workspace_id": workspace})
        )]
    );
    assert!(!log.contains("no workspace guidance"), "{log}");
}

#[tokio::test]
async fn without_guidance_for_head_agents_a_curate_runs_on_and_logs_why_once() {
    let workspace = "ws-guidance-none";
    for (core, why) in [
        (None, "core is not installed"),
        (
            Some(Ok(served(workspace, &["mason"]))),
            "the guidance in /work/cortexkit is not for head agents (its audience: mason)",
        ),
        (
            Some(Err(crate::client::CoreRefusal {
                code: "workspace_index_unavailable".into(),
                message: "the index is rebuilding".into(),
                detail: Some(json!({"retryable": true, "retry_after_ms": 60000})),
            })),
            "core's workspace index is unavailable (workspace_index_unavailable, retryable after 60000 ms): the index is rebuilding; not asked again in this run",
        ),
    ] {
        let (sent, outcome, calls, log) = project_curate_with(workspace, core).await;
        assert!(!sent.contains("workspace-guidance"), "{why}: {sent}");
        assert!(sent.contains("Run the gate script before delivering a change."));
        assert_eq!(outcome.as_deref(), Some("nothing_to_do"), "{why}");
        assert_eq!(calls.len(), 1, "{why}");
        let line = format!("no workspace guidance shown ({why})");
        assert_eq!(log.matches(&line).count(), 1, "{why}: {log}");
        assert_eq!(log.matches("no workspace guidance").count(), 1, "{log}");
        assert!(log.contains(" INFO "), "{log}");
    }
}

#[tokio::test]
async fn a_workspace_curate_shows_the_guidance_core_serves_its_workspace() {
    let (_dir, db) = store();
    let workspace = "ws-guidance-shared";
    insert(
        &db,
        &[Row {
            owner: workspace.into(),
            ..rule(1, "Run `cargo fmt --all` before every commit.")
        }],
    );
    let engine = engine(
        &db,
        vec![Box::new(CurateWorkspace)],
        workspace,
        &["subc", "magic-context"],
    );
    let mut client = Client::new(&["p/a"], &[Ends::Reply("<curate></curate>")]);
    client.entorhinal = Some(listing(workspace, &["subc", "magic-context"]));
    client.core = Some(Ok(served(workspace, &["head"])));
    let client = Arc::new(client);
    round(&engine, &db, &client).await;
    make_due(&db, &OwnerKey::workspace(workspace), "swe:curate-workspace");
    round(&engine, &db, &client).await;
    let sent = sent(&client);
    assert_eq!(sent.len(), 1);
    assert!(sent[0].contains(&in_json(&format!(
        "<workspace-guidance>\nEvery agent in the workspace reads this at the start of every session.\n{GUIDANCE}\n</workspace-guidance>"
    ))));
    assert_eq!(
        client.core_calls.lock().unwrap().clone(),
        [(
            "persona.workspace_document".to_owned(),
            json!({"workspace_id": workspace})
        )]
    );
}

/// Lift replies: each places both rules of one project, moving the first
/// or keeping both.
const MOVE_1: &str = "<place>\n<memory id=\"1\" level=\"workspace\" reason=\"Holds for every project.\"/>\n<memory id=\"2\" level=\"project\"/>\n</place>";
const KEEP_1_2: &str =
    "<place>\n<memory id=\"1\" level=\"project\"/>\n<memory id=\"2\" level=\"project\"/>\n</place>";
const KEEP_3_4: &str =
    "<place>\n<memory id=\"3\" level=\"project\"/>\n<memory id=\"4\" level=\"project\"/>\n</place>";
const MOVE_5: &str = "<place>\n<memory id=\"5\" level=\"workspace\" reason=\"Holds for every project.\"/>\n<memory id=\"6\" level=\"project\"/>\n</place>";

/// Two live rules of project `pj-<name>`, ids `first` and `first + 1`.
fn project_rules(db: &ContextDb, name: &str, first: i64) {
    let rows: Vec<Row> = [first, first + 1]
        .into_iter()
        .map(|id| Row {
            level: "project",
            owner: format!("pj-{name}"),
            ..rule(id, &format!("Rule {id} of {name}."))
        })
        .collect();
    insert(db, &rows);
}

#[tokio::test]
async fn the_lift_takes_the_workspace_lock_before_the_projects_or_neither() {
    let (_dir, db) = store();
    let workspace = "ws-cw-locks";
    project_rules(&db, "magic-context", 1);
    let tasks: Vec<Box<dyn Task>> = vec![Box::new(LiftWorkspace)];
    let engine = engine(&db, tasks, workspace, &["magic-context"]);
    let client = client(
        Some(listing(workspace, &["magic-context", "subc"])),
        &[Ends::Reply(MOVE_1)],
    );
    let (workspace_key, project_key) = (
        OwnerKey::workspace(workspace),
        OwnerKey::project("pj-magic-context"),
    );
    let hold = |owner: &OwnerKey| {
        assert!(db
            .with_connection(|conn| store::lock(
                conn,
                owner,
                "other",
                "swe:curate",
                now_ms(),
                now_ms() + 600_000
            ))
            .unwrap());
    };
    let free = |owner: &OwnerKey| {
        db.with_connection(|conn| store::unlock(conn, owner, "other"))
            .unwrap();
    };

    // Another writer holds the workspace's memories: the lift takes
    // neither lock and sends nothing.
    hold(&workspace_key);
    round(&engine, &db, &client).await;
    assert_eq!(
        locks(&db),
        [("workspace".into(), workspace.into(), "other".into())]
    );
    assert!(runs(&db).is_empty());
    free(&workspace_key);

    // Another writer holds the project's: the same, and the workspace's
    // free lock is not left taken.
    hold(&project_key);
    round(&engine, &db, &client).await;
    assert_eq!(
        locks(&db),
        [("project".into(), "pj-magic-context".into(), "other".into())]
    );
    assert!(runs(&db).is_empty());
    free(&project_key);

    // Both free: the lift runs, holding both, and lets both go.
    round(&engine, &db, &client).await;
    assert_eq!(runs(&db).len(), 1);
    assert!(locks(&db).is_empty());

    // In this process, a run of the workspace's memories keeps the lift
    // from starting as well.
    assert!(engine.claim(std::slice::from_ref(&workspace_key)));
    assert!(!engine.claim(&[workspace_key.clone(), project_key.clone()]));
    assert!(!engine.running.lock().unwrap().contains(&project_key));
    engine.release(std::slice::from_ref(&workspace_key));
}

/// When the last lift of `name` ended, as its record says.
fn lift_ended(db: &ContextDb, name: &str) -> i64 {
    db.with_connection(|conn| {
        store::once_record(
            conn,
            &OwnerKey::project(&format!("pj-{name}")),
            "swe:lift-workspace",
        )
    })
    .unwrap()
    .last_run_at
    .unwrap()
}

#[tokio::test]
async fn the_workspace_curate_is_due_half_an_hour_after_the_last_lift_that_moved_memories() {
    let (_dir, db) = store();
    let workspace = "ws-cw-after-lift";
    project_rules(&db, "magic-context", 1);
    project_rules(&db, "subc", 3);
    project_rules(&db, "entorhinal", 5);
    let client = client(
        Some(listing(workspace, &["magic-context", "subc", "entorhinal"])),
        &[
            Ends::Reply(MOVE_1),
            Ends::Reply(KEEP_3_4),
            Ends::Reply(MOVE_5),
        ],
    );
    let tasks: Vec<Box<dyn Task>> = vec![Box::new(LiftWorkspace), Box::new(CurateWorkspace)];
    let engine = Arc::new(Engine::new("this", tasks));
    let owner = OwnerKey::workspace(workspace);
    let curate = |db: &ContextDb| due_at(db, &owner, "swe:curate-workspace");

    // The first project's lift moves a memory: the curate is due half an
    // hour after it ended.
    see(&engine, &db, workspace, "magic-context");
    round(&engine, &db, &client).await;
    let first = lift_ended(&db, "magic-context");
    assert_eq!(curate(&db), Some(first + CURATE_AFTER_LIFT));

    // The second's moves nothing: the curate stays where it was.
    see(&engine, &db, workspace, "subc");
    round(&engine, &db, &client).await;
    assert!(lift_ended(&db, "subc") >= first);
    assert_eq!(curate(&db), Some(first + CURATE_AFTER_LIFT));

    // The third's moves one: the curate moves to half an hour after it.
    see(&engine, &db, workspace, "entorhinal");
    round(&engine, &db, &client).await;
    let third = lift_ended(&db, "entorhinal");
    assert_eq!(curate(&db), Some(third + CURATE_AFTER_LIFT));
    assert_eq!(client.sends.lock().unwrap().len(), 3);
    // Three lifts, and no curate run yet.
    assert_eq!(runs(&db).len(), 3);
}

#[tokio::test]
async fn without_a_lift_that_moves_memories_the_curate_keeps_its_slot() {
    let (_dir, db) = store();
    let workspace = "ws-cw-no-lift";
    project_rules(&db, "magic-context", 1);
    let client = client(
        Some(listing(workspace, &["magic-context", "subc"])),
        &[Ends::Reply(KEEP_1_2)],
    );
    let tasks: Vec<Box<dyn Task>> = vec![Box::new(LiftWorkspace), Box::new(CurateWorkspace)];
    let engine = engine(&db, tasks, workspace, &["magic-context"]);
    let before = now_ms();
    round(&engine, &db, &client).await;
    // The lift ran and moved nothing; the scheduling check of the same
    // round gave the workspace its weekly slot.
    assert_eq!(runs(&db).len(), 1);
    let owner = OwnerKey::workspace(workspace);
    assert_eq!(
        due_at(&db, &owner, "swe:curate-workspace"),
        crate::dreamer::cron::next_due("0 4 * * 0", before)
    );
}
