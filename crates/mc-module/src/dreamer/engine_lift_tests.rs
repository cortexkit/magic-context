//! The once-per-workspace lift as the engine runs it: never on a schedule,
//! only for a project whose workspace Entorhinal lists with two or more
//! projects, and recorded so it runs once per project and workspace.

use std::sync::Arc;

use serde_json::{json, Value};

use super::*;
use crate::dreamer::run::tests::{Client, Ends};
use crate::dreamer::tasks::lift_workspace::tests::{insert, row, PROJECT};
use crate::dreamer::tasks::lift_workspace::LiftWorkspace;
use crate::workspace_members::tests::answer;

/// A reply that moves memory 1 and keeps memory 2.
const MOVE_ONE: &str = "<place>\n<memory id=\"1\" level=\"workspace\" reason=\"Holds for every project.\"/>\n<memory id=\"2\" level=\"project\"/>\n</place>";

fn store() -> (tempfile::TempDir, Arc<ContextDb>) {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    insert(&db, &[row(1), row(2)]);
    (dir, Arc::new(db))
}

/// The bundled profile, with the lift switched on as `enabled` says.
fn profile(enabled: bool) -> Arc<Profile> {
    let mut profile = crate::memory_profile::prompt_profile(None).unwrap();
    for task in profile.body["tasks"].as_array_mut().unwrap() {
        if task["id"] == "swe:lift-workspace" {
            task["enabled"] = json!(enabled);
        }
    }
    Arc::new(profile)
}

/// Entorhinal's answer listing `workspace` with the projects `names`.
fn listing(workspace: &str, names: &[&str]) -> Value {
    let projects: Vec<(String, String)> = names
        .iter()
        .enumerate()
        .map(|(index, name)| (format!("pj-{workspace}-{index}"), (*name).to_owned()))
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

/// An engine that runs only the lift, having seen the test project in
/// `workspace` with `profile`.
fn engine(db: &ContextDb, profile: Arc<Profile>, workspace: &str) -> Arc<Engine> {
    let engine = Arc::new(Engine::new("this", vec![Box::new(LiftWorkspace)]));
    engine.see_project(db, PROJECT, "/nowhere", profile, &Settings::default(), 1);
    engine.see_workspace(PROJECT, Some(workspace));
    engine
}

async fn settled(engine: &Engine) {
    for _ in 0..500 {
        if engine.running.lock().unwrap().is_empty() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the run never ended");
}

/// Each run's task, kind and outcome.
fn runs(db: &ContextDb) -> Vec<(String, String, Option<String>)> {
    db.with_connection(|conn| {
        conn.prepare("SELECT task, kind, outcome FROM dream_task_runs ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
    })
    .unwrap()
}

fn record(db: &ContextDb) -> store::OnceRecord {
    db.with_connection(|conn| {
        store::once_record(conn, &OwnerKey::project(PROJECT), "swe:lift-workspace")
    })
    .unwrap()
}

/// The schedule rows of the test project: task, schedule and due time.
fn schedules(db: &ContextDb) -> Vec<(String, String, Option<i64>)> {
    db.with_connection(|conn| {
        conn.prepare("SELECT task, schedule, next_due_at FROM dream_schedules ORDER BY task")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
    })
    .unwrap()
}

fn level(db: &ContextDb, id: i64) -> String {
    db.with_connection(|conn| {
        conn.query_row("SELECT level FROM memories WHERE id = ?1", [id], |row| {
            row.get(0)
        })
    })
    .unwrap()
}

#[tokio::test]
async fn a_round_with_the_bundled_profile_lifts_a_shared_workspace_once() {
    let (_dir, db) = store();
    // Every task the module runs, the bundled profile as it ships, and a
    // workspace Entorhinal lists with two projects. The scheduled tasks'
    // first slots are still to come.
    let engine = Arc::new(Engine::new("this", crate::dreamer::tasks()));
    engine.see_project(
        &db,
        PROJECT,
        "/nowhere",
        Arc::new(crate::memory_profile::prompt_profile(None).unwrap()),
        &Settings::default(),
        now_ms(),
    );
    engine.see_workspace(PROJECT, Some("ws-lift-bundled"));
    let client = client(
        Some(listing("ws-lift-bundled", &["subc", "magic-context"])),
        &[Ends::Reply(MOVE_ONE)],
    );
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    // The bundled profile ships the lift on: the first round runs it once
    // for the shared workspace, and the memory the reply places moves.
    assert_eq!(client.sends.lock().unwrap().len(), 1);
    assert_eq!(runs(&db).len(), 1);
    assert_ne!(record(&db), store::OnceRecord::default());
    assert_eq!(level(&db, 1), "workspace");
}

#[tokio::test]
async fn a_workspace_of_one_project_gets_no_run_and_no_record() {
    let (_dir, db) = store();
    let engine = engine(&db, profile(true), "ws-lift-solo");
    let client = client(
        Some(listing("ws-lift-solo", &["magic-context"])),
        &[Ends::Reply(MOVE_ONE)],
    );
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert!(client.sends.lock().unwrap().is_empty());
    assert!(runs(&db).is_empty());
    // Nothing is recorded, so a second project joining the workspace later
    // still gets the project its run.
    assert_eq!(record(&db), store::OnceRecord::default());
    assert!(schedules(&db).is_empty());
}

#[tokio::test]
async fn without_an_answer_from_entorhinal_the_project_is_skipped_not_done() {
    let (_dir, db) = store();
    let engine = engine(&db, profile(true), "ws-lift-silent");
    let client = client(None, &[Ends::Reply(MOVE_ONE)]);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert!(client.sends.lock().unwrap().is_empty());
    assert!(runs(&db).is_empty());
    let record = record(&db);
    assert_eq!(record, store::OnceRecord::default());
    // Not done: a later round tries again at once.
    assert_eq!(once_retry_at(&record, "ws-lift-silent"), Some(0));
}

#[tokio::test]
async fn a_lift_runs_once_per_project_and_workspace() {
    let (_dir, db) = store();
    let engine = engine(&db, profile(true), "ws-lift-once");
    let client = client(
        Some(listing("ws-lift-once", &["subc", "magic-context"])),
        &[Ends::Reply(MOVE_ONE)],
    );
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert_eq!(client.sends.lock().unwrap().len(), 1);
    assert_eq!(
        runs(&db),
        [(
            "swe:lift-workspace".into(),
            "lift-workspace".into(),
            Some("applied".into())
        )]
    );
    assert_eq!(
        (level(&db, 1), level(&db, 2)),
        ("workspace".into(), "project".into())
    );
    let done = record(&db);
    assert_eq!(done.done_for.as_deref(), Some("ws-lift-once"));
    assert_eq!(done.last_status.as_deref(), Some("applied"));
    // The record has no schedule and no due time: no scheduled round starts
    // the task.
    assert_eq!(
        schedules(&db),
        [("swe:lift-workspace".into(), String::new(), None)]
    );
    assert!(db
        .with_connection(|conn| store::due(conn, i64::MAX))
        .unwrap()
        .is_empty());

    // The next rounds find the workspace done and send nothing more.
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;
    assert_eq!(client.sends.lock().unwrap().len(), 1);
    assert_eq!(runs(&db).len(), 1);
}

#[tokio::test]
async fn a_project_that_moves_to_another_workspace_gets_one_run_there() {
    let (_dir, db) = store();
    // The project's lift already ran in its first workspace.
    db.with_connection(|conn| {
        store::settle_once(
            conn,
            &OwnerKey::project(PROJECT),
            "swe:lift-workspace",
            "ws-lift-first",
            Some(1),
            &RunEnd {
                outcome: "applied".into(),
                ..RunEnd::default()
            },
            now_ms(),
        )
    })
    .unwrap();
    let engine = engine(&db, profile(true), "ws-lift-second");
    let client = client(
        Some(listing(
            "ws-lift-second",
            &["subc", "magic-context", "entorhinal"],
        )),
        &[Ends::Reply(MOVE_ONE)],
    );
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert_eq!(client.sends.lock().unwrap().len(), 1);
    assert_eq!(record(&db).done_for.as_deref(), Some("ws-lift-second"));
    // The second workspace's three projects are named in the message.
    let sends = client.sends.lock().unwrap();
    let message = serde_json::to_string(&sends[0].1).unwrap();
    assert!(message.contains("with 3 projects: entorhinal, magic-context, subc"));
}

#[tokio::test]
async fn a_lift_that_fails_is_recorded_as_not_done_and_waits_before_it_is_tried_again() {
    let (_dir, db) = store();
    let engine = engine(&db, profile(true), "ws-lift-failing");
    // The model's reply leaves memory 2 out, every time it is asked.
    let incomplete =
        "<place>\n<memory id=\"1\" level=\"workspace\" reason=\"Holds for every project.\"/>\n</place>";
    let client = client(
        Some(listing("ws-lift-failing", &["subc", "magic-context"])),
        &[
            Ends::Reply(incomplete),
            Ends::Reply(incomplete),
            Ends::Reply(incomplete),
        ],
    );
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert_eq!(runs(&db)[0].2.as_deref(), Some("failed"));
    assert_eq!(level(&db, 1), "project");
    let failed = record(&db);
    assert_eq!(failed.done_for, None);
    assert_eq!(failed.failures, 1);
    let retry = once_retry_at(&failed, "ws-lift-failing").unwrap();
    assert_eq!(retry, failed.last_run_at.unwrap() + ONCE_RETRY);

    // A round before then starts nothing.
    let sent = client.sends.lock().unwrap().len();
    engine.tick(&db, &client, &Settings::default(), retry - 1);
    settled(&engine).await;
    assert_eq!(client.sends.lock().unwrap().len(), sent);
    assert_eq!(runs(&db).len(), 1);
}

#[test]
fn a_lift_is_never_given_a_schedule_whatever_the_settings_say() {
    let (_dir, db) = store();
    let mut settings = Settings::default();
    settings
        .schedules
        .insert("lift-workspace".into(), "0 3 * * *".into());
    let engine = Arc::new(Engine::new("this", vec![Box::new(LiftWorkspace)]));
    engine.see_project(&db, PROJECT, "/nowhere", profile(true), &settings, 1);
    assert!(schedules(&db).is_empty());
}

#[test]
fn retries_wait_longer_after_each_failure_up_to_a_day() {
    let record = |failures, done_for: Option<&str>| store::OnceRecord {
        done_for: done_for.map(str::to_owned),
        last_run_at: Some(1_000),
        last_status: Some(if failures > 0 { "failed" } else { "applied" }.into()),
        failures,
    };
    assert_eq!(once_retry_at(&record(0, Some("ws")), "ws"), None);
    assert_eq!(once_retry_at(&record(0, Some("ws-old")), "ws"), Some(0));
    assert_eq!(
        once_retry_at(&record(1, None), "ws"),
        Some(1_000 + ONCE_RETRY)
    );
    assert_eq!(
        once_retry_at(&record(3, None), "ws"),
        Some(1_000 + 3 * ONCE_RETRY)
    );
    assert_eq!(
        once_retry_at(&record(40, None), "ws"),
        Some(1_000 + ONCE_RETRY_MAX)
    );
}
