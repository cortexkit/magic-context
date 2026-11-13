use std::sync::Arc;

use rusqlite::params;
use serde_json::json;

use super::*;
use crate::dreamer::cron;
use crate::dreamer::run::tests::{Client, Ends};
use crate::dreamer::task::{Applied, Batch, Task, TaskContext};
use crate::summary::fit::Window;

const PROJECT: &str = "pj-test";

/// A classify-memories stand-in: `batches` batches, each accepting only the
/// reply `"ok"` and writing one row naming its run when applied.
struct Fake {
    batches: usize,
}

struct FakeBatch(usize);

impl Task for Fake {
    fn kind(&self) -> &'static str {
        "classify-memories"
    }
    fn batches(&self, _: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String> {
        Ok((0..self.batches)
            .map(|index| Box::new(FakeBatch(index)) as Box<dyn Batch>)
            .collect())
    }
}

impl run::TaskInput for FakeBatch {
    fn system(&self) -> &str {
        "system"
    }
    fn prompt(&self, _: Window, _: u64) -> Option<String> {
        Some(format!("batch {}", self.0))
    }
    fn accepts(&self, reply: &str) -> Result<(), String> {
        (reply == "ok")
            .then_some(())
            .ok_or_else(|| format!("not ok: {reply}"))
    }
}

impl Batch for FakeBatch {
    fn apply(
        &self,
        tx: &rusqlite::Transaction<'_>,
        _: &TaskReply,
        run: i64,
    ) -> Result<Applied, String> {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS applied_batches(run INTEGER, batch INTEGER)")
            .and_then(|_| {
                tx.execute(
                    "INSERT INTO applied_batches(run, batch) VALUES (?1, ?2)",
                    params![run, self.0 as i64],
                )
            })
            .map_err(|error| error.to_string())?;
        Ok(Applied {
            proposed: 2,
            applied: 1,
            dropped: vec![format!("batch {} dropped one", self.0)],
        })
    }
}

fn store() -> (tempfile::TempDir, Arc<ContextDb>) {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    (dir, Arc::new(db))
}

fn engine(batches: usize) -> Arc<Engine> {
    Arc::new(Engine::new("this", vec![Box::new(Fake { batches })]))
}

fn profile() -> Arc<Profile> {
    Arc::new(crate::memory_profile::prompt_profile(None).unwrap())
}

/// Make every schedule due now.
fn make_due(db: &ContextDb) {
    db.with_connection(|conn| conn.execute("UPDATE dream_schedules SET next_due_at = 1", []))
        .unwrap();
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

fn schedule(db: &ContextDb) -> (String, Option<String>, Option<String>, Option<i64>) {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT task, last_status, last_error, next_due_at FROM dream_schedules",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
    })
    .unwrap()
}

/// Each run's task, outcome, proposed and applied counts, and dropped list.
type RunRow = (String, Option<String>, i64, i64, Option<String>);

fn runs(db: &ContextDb) -> Vec<RunRow> {
    db.with_connection(|conn| {
        conn.prepare("SELECT task, outcome, proposed, applied, dropped_json FROM dream_task_runs ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))
            .unwrap()
            .collect::<Result<_, _>>()
    })
    .unwrap()
}

fn locks(db: &ContextDb) -> i64 {
    db.with_connection(|conn| {
        conn.query_row("SELECT COUNT(*) FROM dream_locks", [], |row| row.get(0))
    })
    .unwrap()
}

#[test]
fn a_project_gets_a_schedule_for_each_task_its_profile_declares_and_the_module_runs() {
    let (_dir, db) = store();
    let engine = engine(1);
    let now = now_ms();
    engine.see_project(
        &db,
        PROJECT,
        "/nowhere",
        profile(),
        &Settings::default(),
        now,
    );
    let (task, status, _, due) = schedule(&db);
    // The bundled profile declares many tasks; only the one this engine
    // implements is scheduled, at its default time.
    assert_eq!((task.as_str(), status), ("swe:classify-memories", None));
    assert_eq!(
        due,
        cron::next_due(default_schedule("classify-memories"), now)
    );

    // A person's schedule replaces the default; "" switches the task off.
    let mut settings = Settings::default();
    settings
        .schedules
        .insert("classify-memories".into(), String::new());
    engine.see_project(&db, PROJECT, "/nowhere", profile(), &settings, now);
    assert_eq!(schedule(&db).3, None);
}

#[tokio::test]
async fn a_due_task_sends_each_batch_and_applies_each_accepted_reply() {
    let (_dir, db) = store();
    let engine = engine(2);
    let client = Arc::new(Client::new(
        &["p/a"],
        &[Ends::Reply("ok"), Ends::Reply("ok")],
    ));
    engine.see_project(&db, PROJECT, "/nowhere", profile(), &Settings::default(), 1);
    make_due(&db);

    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    // Each batch had a child of its own, named after the run and the batch.
    assert_eq!(client.children(), ["mc-dream:1.0:0.0", "mc-dream:1.1:0.0"]);
    let applied: Vec<(i64, i64)> = db
        .with_connection(|conn| {
            conn.prepare("SELECT run, batch FROM applied_batches ORDER BY batch")
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
        })
        .unwrap();
    assert_eq!(applied, [(1, 0), (1, 1)]);
    assert_eq!(
        runs(&db),
        [(
            "swe:classify-memories".into(),
            Some("applied".into()),
            4,
            2,
            Some(json!(["batch 0 dropped one", "batch 1 dropped one"]).to_string())
        )]
    );
    let (_, status, error, due) = schedule(&db);
    assert_eq!((status.as_deref(), error), (Some("applied"), None));
    assert!(due.unwrap() > now_ms());
    assert_eq!(locks(&db), 0);
}

#[tokio::test]
async fn an_unseen_project_or_one_already_running_starts_nothing() {
    let (_dir, db) = store();
    let engine = engine(1);
    let client = Arc::new(Client::new(&["p/a"], &[Ends::Reply("ok")]));
    engine.see_project(&db, PROJECT, "/nowhere", profile(), &Settings::default(), 1);
    make_due(&db);
    // A due task of a project no session has set up in this process waits.
    engine.projects.lock().unwrap().clear();
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;
    assert!(client.sends.lock().unwrap().is_empty());
    assert_eq!(schedule(&db).1, None);
}

#[tokio::test]
async fn another_writers_lock_skips_the_run_without_a_record() {
    let (_dir, db) = store();
    let engine = engine(1);
    let client = Arc::new(Client::new(&["p/a"], &[Ends::Reply("ok")]));
    engine.see_project(&db, PROJECT, "/nowhere", profile(), &Settings::default(), 1);
    make_due(&db);
    db.with_connection(|conn| {
        store::lock(
            conn,
            &OwnerKey::project(PROJECT),
            "other",
            "swe:curate",
            now_ms(),
            now_ms() + 60_000,
        )
    })
    .unwrap();

    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert!(client.sends.lock().unwrap().is_empty());
    assert!(runs(&db).is_empty());
    let (_, status, error, _) = schedule(&db);
    assert_eq!(status.as_deref(), Some("skipped"));
    assert!(error.unwrap().contains("another writer"));
    // The other writer's lock stays.
    assert_eq!(locks(&db), 1);
}

#[tokio::test]
async fn a_spent_budget_stops_the_run_before_its_next_batch() {
    let (_dir, db) = store();
    let engine = engine(2);
    let client = Arc::new(Client::new(&["p/a"], &[]));
    let settings = Settings {
        budget_tokens: 0,
        ..Settings::default()
    };
    engine.see_project(&db, PROJECT, "/nowhere", profile(), &settings, 1);
    make_due(&db);
    engine.tick(&db, &client, &settings, now_ms());
    settled(&engine).await;
    assert!(client.sends.lock().unwrap().is_empty());
    assert_eq!(runs(&db)[0].1.as_deref(), Some("budget_stopped"));
    assert_eq!(schedule(&db).1.as_deref(), Some("budget_stopped"));
}

#[tokio::test]
async fn an_account_wait_ends_the_run_as_a_wait_due_when_it_ends() {
    let (_dir, db) = store();
    let engine = engine(1);
    let mut client = Client::new(&["p/a"], &[]);
    // Inside the one-hour cap a routing wait has.
    let reset = now_ms() + 30 * 60_000;
    client.refuse = Some(crate::routing::RouteError {
        code: "no_route".into(),
        message: "every account is out".into(),
        detail: Some(json!({"reason": "quota_or_cooldown", "reset_at_ms": reset})),
    });
    let client = Arc::new(client);
    engine.see_project(&db, PROJECT, "/nowhere", profile(), &Settings::default(), 1);
    make_due(&db);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;
    assert_eq!(runs(&db)[0].1.as_deref(), Some("waiting"));
    let (_, status, _, due) = schedule(&db);
    assert_eq!(status.as_deref(), Some("waiting"));
    // Due when the wait ends, unless the next slot comes first.
    let slot = cron::next_due(default_schedule("classify-memories"), now_ms()).unwrap();
    assert_eq!(due, Some(slot.min(reset)));
}

#[tokio::test]
async fn a_failed_model_counts_a_failure_and_releases_the_lock() {
    let (_dir, db) = store();
    let engine = engine(1);
    let client = Arc::new(Client::new(
        &["p/a", "p/b", "p/c"],
        &[Ends::Reply("x"), Ends::Reply("y"), Ends::Reply("z")],
    ));
    engine.see_project(&db, PROJECT, "/nowhere", profile(), &Settings::default(), 1);
    make_due(&db);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;
    assert_eq!(runs(&db)[0].1.as_deref(), Some("failed"));
    let failures: i64 = db
        .with_connection(|conn| {
            conn.query_row("SELECT failures FROM dream_schedules", [], |row| row.get(0))
        })
        .unwrap();
    assert_eq!(failures, 1);
    assert_eq!(locks(&db), 0);
}

#[test]
fn a_reply_is_not_applied_once_the_lock_passed_to_another_writer() {
    let (_dir, db) = store();
    let owner = OwnerKey::project(PROJECT);
    db.with_connection(|conn| {
        store::lock(
            conn,
            &owner,
            "other",
            "swe:curate",
            now_ms(),
            now_ms() + 60_000,
        )
    })
    .unwrap();
    let reply = TaskReply {
        text: "ok".into(),
        prompt: "batch 0".into(),
        model: cortexkit_role_compaction::setup::ModelRef::new("p", "a"),
        runner: "ra".into(),
        child: "c".into(),
        usage: None,
    };
    assert_eq!(
        apply(&db, &owner, "this", &FakeBatch(0), &reply, 1),
        Ok(None)
    );
    let written: bool = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'applied_batches')",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert!(!written);
}

#[test]
fn a_task_reading_files_or_git_needs_them_on_this_machine() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let files = json!({"reads": ["memory-pool", "repo-files"]});
    let git = json!({"reads": ["repo-files", "git"]});
    assert_eq!(missing_evidence(&files, root), None);
    assert!(missing_evidence(&files, "/no/such/folder")
        .unwrap()
        .contains("not on this machine"));
    assert!(missing_evidence(&git, root)
        .unwrap()
        .contains("no git history"));
    std::fs::create_dir(dir.path().join(".git")).unwrap();
    assert_eq!(missing_evidence(&git, root), None);
    assert_eq!(
        missing_evidence(&json!({"reads": ["memory-pool"]}), "/no/such/folder"),
        None
    );
}
