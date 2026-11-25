use std::sync::Arc;

use rusqlite::params;
use serde_json::json;

use super::*;
use crate::dreamer::cron;
use crate::dreamer::run::tests::{Client, Ends};
use crate::dreamer::task::{Applied, Batch, Task, TaskContext};
use crate::summary::fit::Window;

const PROJECT: &str = "pj-test";
/// A folder that exists, for a project whose tasks read none of its files:
/// a run starts only in a folder that exists.
pub(super) const FOLDER: &str = env!("CARGO_MANIFEST_DIR");

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
    Arc::new(
        Engine::new("this", vec![Box::new(Fake { batches })])
            .with_leases(crate::dreamer::lease_double::SampleLeases::granting()),
    )
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
    engine.see_project(&db, PROJECT, FOLDER, profile(), &Settings::default(), now);
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
    engine.see_project(&db, PROJECT, FOLDER, profile(), &settings, now);
    assert_eq!(schedule(&db).3, None);
}

#[tokio::test]
async fn compress_cues_sends_work_only_when_the_projects_mural_is_enabled() {
    use crate::dreamer::tasks::compress_cues::CompressCues;

    for enabled in [false, true] {
        let (_dir, db) = store();
        db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO memories(id, level, owner_id, category, origin_category, content,
                                      normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES (1, 'project', ?1, 'ARCHITECTURE', 'ARCHITECTURE', 'Gate deploys on a review.', 'test', 0, 0, 0, 0)",
                [PROJECT],
            )
        }).unwrap();
        let engine = Arc::new(
            Engine::new("this", vec![Box::new(CompressCues)])
                .with_leases(crate::dreamer::lease_double::SampleLeases::granting())
                .with_mural_enabled(Arc::new(move |root, project| {
                    assert_eq!((root, project), (FOLDER, PROJECT));
                    enabled
                })),
        );
        let client = Arc::new(Client::new(
            &["p/a"],
            &[Ends::Reply(
                "<cues><cue id=\"1\">Review before deploy</cue></cues>",
            )],
        ));
        let settings = Settings::default();
        engine.see_project(&db, PROJECT, FOLDER, profile(), &settings, 1);
        make_due(&db);
        engine.tick(&db, &client, &settings, now_ms());
        settled(&engine).await;

        assert_eq!(client.children().len(), usize::from(enabled));
        if !enabled {
            let (outcome, error): (String, String) = db
                .with_connection(|conn| {
                    conn.query_row("SELECT outcome, error FROM dream_task_runs", [], |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    })
                })
                .unwrap();
            assert_eq!(
                (outcome.as_str(), error.as_str()),
                ("nothing_to_do", "mural is not enabled")
            );
        }
    }
}

#[tokio::test]
async fn a_due_task_sends_each_batch_and_applies_each_accepted_reply() {
    let (_dir, db) = store();
    let engine = engine(2);
    let client = Arc::new(Client::new(
        &["p/a"],
        &[Ends::Reply("ok"), Ends::Reply("ok")],
    ));
    engine.see_project(&db, PROJECT, FOLDER, profile(), &Settings::default(), 1);
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

/// A memory task whose one batch journals a decision about a memory of
/// [`PROJECT`], as every memory task's apply does.
struct Journaling;

struct JournalingBatch;

impl Task for Journaling {
    fn kind(&self) -> &'static str {
        "classify-memories"
    }
    fn batches(&self, _: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String> {
        Ok(vec![Box::new(JournalingBatch)])
    }
}

impl run::TaskInput for JournalingBatch {
    fn system(&self) -> &str {
        "system"
    }
    fn prompt(&self, _: Window, _: u64) -> Option<String> {
        Some("batch".into())
    }
    fn accepts(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

impl Batch for JournalingBatch {
    fn apply(
        &self,
        tx: &rusqlite::Transaction<'_>,
        _: &TaskReply,
        run: i64,
    ) -> Result<Applied, String> {
        tx.execute(
            "INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at)
             VALUES (?1, ?2, 'classify', '{}', 1)",
            params![PROJECT, format!("dream:{run}")],
        )
        .map_err(|error| error.to_string())?;
        Ok(Applied {
            proposed: 1,
            applied: 1,
            dropped: Vec::new(),
        })
    }
}

#[tokio::test]
async fn an_applied_memory_task_wakes_its_project() {
    let test_bus = crate::bus::tests::TestBus::new();
    let (_dir, db, wakes, mut publisher) = crate::memory_changed::tests::watched(&test_bus);
    let floor = db
        .with_connection(|conn| crate::memory_changed::revision(conn))
        .unwrap();
    let engine = Arc::new(
        Engine::new("this", vec![Box::new(Journaling)])
            .with_leases(crate::dreamer::lease_double::SampleLeases::granting()),
    );
    let client = Arc::new(Client::new(&["p/a"], &[Ends::Reply("ok")]));
    engine.see_project(&db, PROJECT, FOLDER, profile(), &Settings::default(), 1);
    make_due(&db);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;
    assert_eq!(runs(&db)[0].1.as_deref(), Some("applied"));
    let sent = publisher.round(&db, wakes.take()).await;
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(
        sent[0].owner,
        crate::memory_changed::Owner::of("project", PROJECT).unwrap()
    );
    assert!(sent[0].revision > floor);
    assert_eq!(
        test_bus.notices()[0].0,
        format!("project:{PROJECT}:{}", sent[0].revision)
    );
}

#[tokio::test]
async fn an_unseen_project_or_one_already_running_starts_nothing() {
    let (_dir, db) = store();
    let engine = engine(1);
    let client = Arc::new(Client::new(&["p/a"], &[Ends::Reply("ok")]));
    engine.see_project(&db, PROJECT, FOLDER, profile(), &Settings::default(), 1);
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
    engine.see_project(&db, PROJECT, FOLDER, profile(), &Settings::default(), 1);
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
    engine.see_project(&db, PROJECT, FOLDER, profile(), &settings, 1);
    make_due(&db);
    engine.tick(&db, &client, &settings, now_ms());
    settled(&engine).await;
    assert!(client.sends.lock().unwrap().is_empty());
    assert_eq!(runs(&db)[0].1.as_deref(), Some("budget_stopped"));
    assert_eq!(schedule(&db).1.as_deref(), Some("budget_stopped"));
}

#[tokio::test]
async fn a_settled_attempt_that_spends_the_budget_cannot_send_a_fallback() {
    let (_dir, db) = store();
    let engine = engine(1);
    let settings = Settings {
        budget_tokens: 60_000,
        ..Settings::default()
    };
    engine.see_project(&db, PROJECT, FOLDER, profile(), &settings, 1);
    make_due(&db);
    let client = Arc::new(Client::new(
        &["p/a", "p/b"],
        &[Ends::Spent("no", 70_000), Ends::Spent("ok", 30_000)],
    ));
    engine.tick(&db, &client, &settings, now_ms());
    settled(&engine).await;
    assert_eq!(client.children().len(), 1);
    let (outcome, input): (String, u64) = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT outcome, input_tokens FROM dream_task_runs",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!((outcome.as_str(), input), ("budget_stopped", 70_000));
}

#[tokio::test]
async fn fallback_and_unsuccessful_batches_count_in_the_run_total() {
    for (ends, budget_tokens, expected) in [
        (
            vec![Ends::Spent("no", 70_000), Ends::Spent("ok", 30_000)],
            90_000,
            "budget_stopped",
        ),
        (
            vec![Ends::Spent("no", 70_000), Ends::Spent("also no", 30_000)],
            110_000,
            "failed",
        ),
        (
            vec![Ends::SpentFull((now_ms() + 120_000) as u64, 100_000)],
            90_000,
            "waiting",
        ),
    ] {
        let (_dir, db) = store();
        let engine = engine(2);
        let settings = Settings {
            budget_tokens,
            ..Settings::default()
        };
        engine.see_project(&db, PROJECT, FOLDER, profile(), &settings, 1);
        make_due(&db);
        let client = Arc::new(Client::new(&["p/a", "p/b"], &ends));
        engine.tick(&db, &client, &settings, now_ms());
        settled(&engine).await;
        let (outcome, input): (String, u64) = db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT outcome, input_tokens FROM dream_task_runs",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!((outcome.as_str(), input), (expected, 100_000));
        assert_eq!(client.children().len(), ends.len());
    }
}

#[tokio::test]
async fn account_waits_share_the_scheduled_occurrences_token_budget() {
    use chrono::Timelike;

    let (_dir, db) = store();
    let engine = engine(3);
    // Leave enough time before the next cron slot for the account to reset.
    let hour = (chrono::Local::now().hour() + 2) % 24;
    let settings = Settings {
        budget_tokens: 20_000_000,
        schedules: [("classify-memories".into(), format!("0 {hour} * * *"))].into(),
        ..Settings::default()
    };
    engine.see_project(&db, PROJECT, FOLDER, profile(), &settings, 1);
    make_due(&db);
    let spent = || {
        db.with_connection(|conn| {
            conn.prepare(
                "SELECT outcome, input_tokens + output_tokens FROM dream_task_runs ORDER BY id",
            )?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
    };

    let now = now_ms();
    let reset = now + 5 * 60_000;
    let client = Arc::new(Client::new(
        &["p/a"],
        &[Ends::SpentFull(reset as u64, 12_000_000)],
    ));
    engine.tick(&db, &client, &settings, now);
    settled(&engine).await;
    assert_eq!(spent(), [("waiting".into(), 12_000_000)]);
    assert_eq!(schedule(&db).3, Some(reset));

    let client = Arc::new(Client::new(
        &["p/a"],
        &[
            Ends::Spent("ok", 8_000_000),
            Ends::Spent("ok", 8_000_000),
            Ends::Spent("ok", 8_000_000),
        ],
    ));
    engine.tick(&db, &client, &settings, schedule(&db).3.unwrap());
    settled(&engine).await;
    let expected = [
        ("waiting".into(), 12_000_000),
        ("budget_stopped".into(), 8_000_000),
    ];
    assert_eq!(spent(), expected);
    assert_eq!(client.children().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn account_reroute_waits_until_routing_reset_then_selects_again() {
    let (_dir, db) = store();
    let engine = engine(1);
    let settings = Settings::default();
    let now = now_ms();
    let reset = now + 10 * 60_000;
    engine.see_project(&db, PROJECT, FOLDER, profile(), &settings, now);
    make_due(&db);
    let client = Arc::new(Client::new(&[], &[Ends::Reply("ok")]));
    client
        .send_errors
        .lock()
        .unwrap()
        .push_back(run::tests::long_account_limit());
    client.route_script.lock().unwrap().extend([
        Ok("p/a"),
        Err(crate::routing::RouteError {
            code: "no_route".into(),
            message: "every rung is walled".into(),
            detail: Some(json!({"reason": "quota_or_cooldown", "reset_at_ms": reset})),
        }),
        Ok("p/b"),
    ]);
    engine.tick(&db, &client, &settings, now);
    settled(&engine).await;
    assert_eq!(schedule(&db).3, Some(reset));
    assert_eq!(client.selects.lock().unwrap().len(), 2);
    engine.tick(&db, &client, &settings, reset - 1);
    settled(&engine).await;
    assert_eq!(client.selects.lock().unwrap().len(), 2);
    engine.tick(&db, &client, &settings, reset);
    settled(&engine).await;
    assert_eq!(client.selects.lock().unwrap().len(), 3);
    assert_eq!(
        *client.reports.lock().unwrap(),
        ["decision-a cancelled", "decision-b completed"]
    );
}

#[tokio::test]
async fn a_curate_run_stopped_by_its_budget_resumes_at_its_next_part() {
    let (_dir, db) = store();
    // Sixty-one rules make two parts of their category; one name makes a
    // part of a later category.
    db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        for id in 1..=62_i64 {
            let (category, tag) = if id <= 61 {
                ("swe:project-rules", "PROJECT_RULES")
            } else {
                ("swe:naming", "NAMING")
            };
            let content = format!("Rule {id}.");
            tx.execute(
                "INSERT INTO memories(id, level, owner_id, category, origin_category, content, normalized_hash,
                                      first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES (?1, 'project', ?2, ?3, ?4, ?5, ?6, 0, 0, 0, 0)",
                params![
                    id,
                    PROJECT,
                    category,
                    tag,
                    content,
                    crate::memory_writes::normalized_hash(&content)
                ],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    });
    let engine = Arc::new(
        Engine::new(
            "this",
            vec![Box::new(crate::dreamer::tasks::curate::Curate)],
        )
        .with_leases(crate::dreamer::lease_double::SampleLeases::granting()),
    );
    let spent = Settings {
        budget_tokens: 100,
        ..Settings::default()
    };
    engine.see_project(&db, PROJECT, FOLDER, profile(), &spent, 1);
    make_due(&db);
    let client = Arc::new(Client::new(
        &["p/a"],
        &[Ends::Spent(
            "<curate><archive id=\"1\" reason=\"one-off\" why=\"a room id\"/></curate>",
            150,
        )],
    ));
    engine.tick(&db, &client, &spent, now_ms());
    settled(&engine).await;

    // The first part was sent and applied; the tokens it used stop the run
    // before the second.
    assert_eq!(client.children(), ["mc-dream:1.0:0.0"]);
    let status: String = db
        .with_connection(|conn| {
            conn.query_row("SELECT status FROM memories WHERE id = 1", [], |row| {
                row.get(0)
            })
        })
        .unwrap();
    assert_eq!(status, "archived");
    let first = &runs(&db)[0];
    assert_eq!(
        (first.0.as_str(), first.1.as_deref(), first.2, first.3),
        ("swe:curate", Some("budget_stopped"), 1, 1)
    );
    assert_eq!(schedule(&db).1.as_deref(), Some("budget_stopped"));
    let watermark = || -> Option<Value> {
        db.with_connection(|conn| {
            conn.query_row("SELECT watermark_json FROM dream_schedules", [], |row| {
                row.get::<_, Option<String>>(0)
            })
        })
        .unwrap()
        .map(|text| serde_json::from_str(&text).unwrap())
    };
    assert_eq!(
        watermark(),
        Some(json!({"category": "swe:project-rules", "part": 2, "after": 60}))
    );

    // The next run starts at the second part and goes on to the end.
    make_due(&db);
    let client = Arc::new(Client::new(
        &["p/a"],
        &[
            Ends::Reply("<curate></curate>"),
            Ends::Reply("<curate></curate>"),
        ],
    ));
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;
    let prompts: Vec<String> = client
        .sends
        .lock()
        .unwrap()
        .iter()
        .map(|(_, request)| request.prompt.clone().unwrap())
        .collect();
    assert_eq!(prompts.len(), 2);
    assert!(
        prompts[0].contains("<memories part=\"2 of 2\">\n[61]\nRule 61.\n</memories>"),
        "{}",
        prompts[0]
    );
    assert!(prompts[1].starts_with("## Curate the `NAMING` memories"));
    assert!(prompts[1].contains("<memories part=\"1 of 1\">\n[62]\nRule 62.\n</memories>"));
    assert_eq!(runs(&db)[1].1.as_deref(), Some("nothing_to_do"));
    // Its last part leaves no resume point: the next run starts over.
    assert_eq!(watermark(), None);
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
    engine.see_project(&db, PROJECT, FOLDER, profile(), &Settings::default(), 1);
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

#[tokio::test(start_paused = true)]
async fn a_never_run_send_waits_until_its_deadline_without_counting_a_failure() {
    for (ends, replies, code, send_count) in [
        (vec![Ends::NeverRan], vec![], "handover_failed", 1),
        (
            vec![],
            vec![cortexkit_role_llm_runner::send::SendReply::new("not_delivered"); 2],
            "not_delivered",
            2,
        ),
    ] {
        let (_dir, db) = store();
        let engine = engine(1);
        let client = Arc::new(Client::new(&["p/a"], &ends));
        *client.send_replies.lock().unwrap() = replies.into();
        engine.see_project(&db, PROJECT, FOLDER, profile(), &Settings::default(), 1);
        make_due(&db);
        db.with_connection(|conn| conn.execute("UPDATE dream_schedules SET failures = 2", []))
            .unwrap();
        let before = now_ms();
        engine.tick(&db, &client, &Settings::default(), before);
        settled(&engine).await;
        let after = now_ms();
        let (outcome, failure_class, batches): (String, Option<String>, String) = db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT outcome, failure_class, batches_json FROM dream_task_runs",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })
            .unwrap();
        assert_eq!(outcome, "waiting");
        assert_eq!(failure_class, None);
        let batches: serde_json::Value = serde_json::from_str(&batches).unwrap();
        assert_eq!(batches[0]["code"], code);
        let deadline = batches[0]["wait_until"].as_i64().unwrap();
        assert!(deadline >= before + 6_000 && deadline <= after + 8_000);
        let (_, status, _, due) = schedule(&db);
        assert_eq!(status.as_deref(), Some("waiting"));
        let slot = cron::next_due(default_schedule("classify-memories"), after).unwrap();
        assert_eq!(due, Some(slot.min(deadline)));
        let failures_in_a_row: i64 = db
            .with_connection(|conn| {
                conn.query_row("SELECT failures FROM dream_schedules", [], |row| row.get(0))
            })
            .unwrap();
        assert_eq!(failures_in_a_row, 2);
        assert_eq!(locks(&db), 0);
        assert_eq!(client.sends.lock().unwrap().len(), send_count);
        assert_eq!(*client.reports.lock().unwrap(), ["decision-a cancelled"]);
        assert!(client.ends.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn a_failed_model_counts_a_failure_and_releases_the_lock() {
    let (_dir, db) = store();
    let engine = engine(1);
    let client = Arc::new(Client::new(
        &["p/a", "p/b", "p/c"],
        &[Ends::Reply("x"), Ends::Reply("y"), Ends::Reply("z")],
    ));
    engine.see_project(&db, PROJECT, FOLDER, profile(), &Settings::default(), 1);
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

/// Routing's full capacity (`concurrency_full`) ends the run as a wait the
/// schedule retries when routing's reset comes: no failure is counted and
/// the project's lock is released.
#[tokio::test]
async fn a_full_capacity_refusal_ends_the_run_as_a_wait_with_no_failure_counted() {
    let (_dir, db) = store();
    let engine = engine(1);
    let mut client = Client::new(&["p/a"], &[]);
    // Within the one-hour limit on how long a routing refusal's wait lasts
    // (`MAX_ROUTING_WAIT_MS`), so the wait ends at routing's reset.
    let reset = now_ms() + 30 * 60_000;
    client.refuse = Some(crate::routing::RouteError {
        code: "no_route".into(),
        message: "every account on every adequate route is at its cap".into(),
        detail: Some(json!({"reason": "concurrency_full", "reset_at_ms": reset})),
    });
    let client = Arc::new(client);
    engine.see_project(&db, PROJECT, FOLDER, profile(), &Settings::default(), 1);
    make_due(&db);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;
    assert_eq!(runs(&db)[0].1.as_deref(), Some("waiting"));
    let (_, status, _, due) = schedule(&db);
    assert_eq!(status.as_deref(), Some("waiting"));
    let failures: i64 = db
        .with_connection(|conn| {
            conn.query_row("SELECT failures FROM dream_schedules", [], |row| row.get(0))
        })
        .unwrap();
    assert_eq!(failures, 0);
    assert_eq!(locks(&db), 0);
    // Due when the wait ends, unless the next slot comes first.
    let slot = cron::next_due(default_schedule("classify-memories"), now_ms()).unwrap();
    assert_eq!(due, Some(slot.min(reset)));
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
        model: cortexkit_role_compaction::setup::ModelRef::new("p", "a"),
        runner: "ra".into(),
        child: "c".into(),
        usage: None,
        steps: None,
    };
    assert_eq!(
        apply(
            &db,
            std::slice::from_ref(&owner),
            "this",
            &FakeBatch(0),
            Some(&reply),
            1,
            &[],
            &|| Ok(()),
        ),
        Ok(Ok(None))
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

/// A project whose folder is gone runs nothing, not even a task that reads
/// no files: a runner refuses to create a child session in a folder that
/// doesn't exist. The task is skipped naming the folder, and a run the
/// person starts is refused the same way.
#[tokio::test]
async fn a_project_whose_folder_is_gone_skips_every_task_and_sends_nothing() {
    let (_dir, db) = store();
    let engine = engine(1);
    let client = Arc::new(Client::new(&["p/a"], &[Ends::Reply("ok")]));
    let parent = tempfile::tempdir().unwrap();
    let gone = parent.path().join("removed");
    let root = gone.to_str().unwrap();
    engine.see_project(&db, PROJECT, root, profile(), &Settings::default(), 1);
    make_due(&db);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;
    assert!(client.sends.lock().unwrap().is_empty());
    assert!(runs(&db).is_empty());
    let (task, status, error, _) = schedule(&db);
    assert_eq!(task, "swe:classify-memories");
    assert_eq!(status.as_deref(), Some("skipped"));
    assert_eq!(
        error,
        Some(format!("the project folder {root} is not on this machine"))
    );
    assert!(matches!(
        engine.run_now(
            &db,
            &client,
            &Settings::default(),
            PROJECT,
            "classify-memories"
        ),
        Err(RunNowRefused::Evidence(reason)) if reason.contains(root)
    ));
    assert!(client.sends.lock().unwrap().is_empty());
}

/// Seeing a project again with only its folder changed moves its next run
/// to the new folder and leaves its schedules as they were.
#[tokio::test]
async fn a_project_seen_again_in_another_folder_runs_there_on_the_same_schedule() {
    let (_dir, db) = store();
    let engine = engine(1);
    let client = Arc::new(Client::new(&["p/a"], &[Ends::Reply("ok")]));
    let (old, new) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let new_root = new.path().to_str().unwrap();
    let now = now_ms();
    engine.see_project(
        &db,
        PROJECT,
        old.path().to_str().unwrap(),
        profile(),
        &Settings::default(),
        now,
    );
    let due = schedule(&db).3;
    engine.see_project(
        &db,
        PROJECT,
        new_root,
        profile(),
        &Settings::default(),
        now + 1,
    );
    assert_eq!(schedule(&db).3, due);
    make_due(&db);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;
    let sends = client.sends.lock().unwrap();
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].0.project_root.as_deref(), Some(new_root));
}

/// A one-batch stand-in for task kind `kind`, accepting the reply `"ok"`.
struct Kinded(&'static str);

impl Task for Kinded {
    fn kind(&self) -> &'static str {
        self.0
    }
    fn batches(&self, _: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String> {
        Ok(vec![Box::new(FakeBatch(0))])
    }
}

/// An engine running stand-ins for classify (reads no code), map and
/// verify (read code), for a project in a folder with git history.
fn reading_engine() -> (tempfile::TempDir, Arc<Engine>) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join(".git")).unwrap();
    let engine = Arc::new(
        Engine::new(
            "this",
            vec![
                Box::new(Kinded("classify-memories")),
                Box::new(Kinded("map-memories")),
                Box::new(Kinded("verify")),
            ],
        )
        .with_leases(crate::dreamer::lease_double::SampleLeases::granting()),
    );
    (dir, engine)
}

/// Each schedule's task, last status, last error and failures in a row.
fn schedules(db: &ContextDb) -> Vec<(String, Option<String>, Option<String>, i64)> {
    db.with_connection(|conn| {
        conn.prepare(
            "SELECT task, last_status, last_error, failures FROM dream_schedules ORDER BY task",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
    })
    .unwrap()
}

const NO_READER: &str = "no code-reading tools: no module provides tool-provider/v1";

#[tokio::test]
async fn without_a_tool_provider_that_reads_code_map_and_verify_are_skipped_and_classify_runs() {
    let (_dir, db) = store();
    let (folder, engine) = reading_engine();
    let root = folder.path().to_str().unwrap();
    let mut client = Client::new(&["p/a"], &[Ends::Reply("ok")]);
    client.providers = Vec::new();
    let client = Arc::new(client);
    engine.see_project(&db, PROJECT, root, profile(), &Settings::default(), 1);
    make_due(&db);
    // One run of a project at a time: a round per task.
    for _ in 0..3 {
        engine.tick(&db, &client, &Settings::default(), now_ms());
        settled(&engine).await;
    }
    assert_eq!(
        schedules(&db),
        [
            (
                "swe:classify-memories".into(),
                Some("applied".into()),
                None,
                0
            ),
            (
                "swe:map-memories".into(),
                Some("skipped".into()),
                Some(NO_READER.into()),
                0
            ),
            (
                "swe:verify".into(),
                Some("skipped".into()),
                Some(NO_READER.into()),
                0
            ),
        ]
    );
    // Only classify ran: the skipped tasks left no run and sent nothing.
    let ran: Vec<String> = runs(&db).into_iter().map(|run| run.0).collect();
    assert_eq!(ran, ["swe:classify-memories"]);
    assert_eq!(client.sends.lock().unwrap().len(), 1);
    assert_eq!(locks(&db), 0);
}

#[tokio::test]
async fn a_code_reading_run_reads_with_the_tool_provider_that_reads_code_whatever_its_id() {
    let (_dir, db) = store();
    let (folder, engine) = reading_engine();
    let root = folder.path().to_str().unwrap();
    let mut client = Client::new(&["p/a"], &[Ends::Reply("ok")]);
    client.plans = vec!["ra"];
    client.providers = vec!["code-reader"];
    client.catalog = Ok(vec![("cat", &["code.read/v1"][..])]);
    let client = Arc::new(client);
    engine.see_project(&db, PROJECT, root, profile(), &Settings::default(), 1);
    let (task, _) = engine
        .run_now(&db, &client, &Settings::default(), PROJECT, "verify")
        .unwrap();
    assert_eq!(task, "swe:verify");
    settled(&engine).await;
    let sends = client.sends.lock().unwrap();
    assert_eq!(sends.len(), 1);
    let plan = sends[0].1.plan.as_ref().expect("a plan");
    assert_eq!(
        plan["tool_items"],
        json!([{"params": {}, "preset": "reader", "provider": "code-reader"}])
    );
    assert_eq!(
        plan["composition"]["providers"][0]["provider"],
        "code-reader"
    );
}

/// A run the person starts on a stack without a reader ends as skipped:
/// not a failure, so nothing counts toward failing.
#[tokio::test]
async fn a_started_run_without_a_reader_ends_as_skipped_not_failed() {
    let (_dir, db) = store();
    let (folder, engine) = reading_engine();
    let root = folder.path().to_str().unwrap();
    let mut client = Client::new(&["p/a"], &[]);
    client.providers = Vec::new();
    let client = Arc::new(client);
    engine.see_project(&db, PROJECT, root, profile(), &Settings::default(), 1);
    engine
        .run_now(&db, &client, &Settings::default(), PROJECT, "map-memories")
        .unwrap();
    settled(&engine).await;
    let run: (String, Option<String>, Option<String>, Option<String>) = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT task, outcome, failure_class, error FROM dream_task_runs",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
        })
        .unwrap();
    assert_eq!(
        run,
        (
            "swe:map-memories".into(),
            Some("skipped".into()),
            None,
            Some(NO_READER.into())
        )
    );
    let map = schedules(&db)
        .into_iter()
        .find(|row| row.0 == "swe:map-memories")
        .unwrap();
    assert_eq!(
        map,
        (
            "swe:map-memories".into(),
            Some("skipped".into()),
            Some(NO_READER.into()),
            0
        )
    );
    assert!(client.sends.lock().unwrap().is_empty());
    assert_eq!(locks(&db), 0);
}

/// A batch that saves one project memory.
struct RememberingBatch;

impl run::TaskInput for RememberingBatch {
    fn system(&self) -> &str {
        "system"
    }
    fn prompt(&self, _: Window, _: u64) -> Option<String> {
        Some("batch".into())
    }
    fn accepts(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

impl Batch for RememberingBatch {
    fn apply(
        &self,
        tx: &rusqlite::Transaction<'_>,
        _: &TaskReply,
        _: i64,
    ) -> Result<Applied, String> {
        tx.execute(
            "INSERT INTO memories (level, owner_id, category, origin_category, content, normalized_hash,
                 first_seen_at, created_at, updated_at, last_seen_at, source_type)
             VALUES ('project', ?1, 'swe:naming', 'NAMING', 'A dreamed rule.', 'h', 1, 1, 1, 1, 'dreamer')",
            params![PROJECT],
        )
        .map_err(|error| error.to_string())?;
        Ok(Applied {
            proposed: 1,
            applied: 1,
            dropped: Vec::new(),
        })
    }
}

/// What a dreamer run applies is captured as the dreamer's, with the run's
/// id and the generation of the role lease its batch was sent under, for
/// the user's other computers. The naming ends with the run's transaction.
#[test]
fn a_batch_the_dreamer_applies_names_its_run_in_the_outbox() {
    let (_dir, db) = store();
    let locks = [OwnerKey::project(PROJECT)];
    db.with_connection(|conn| {
        store::lock(
            conn,
            &locks[0],
            "this",
            "swe:curate",
            now_ms(),
            now_ms() + 60_000,
        )
    })
    .unwrap();
    let reply = TaskReply {
        text: "ok".into(),
        model: cortexkit_role_compaction::setup::ModelRef::new("p", "a"),
        runner: "r".into(),
        child: "c".into(),
        usage: None,
        steps: None,
    };
    let applied = super::apply(
        &db,
        &locks,
        "this",
        &RememberingBatch,
        Some(&reply),
        9,
        &[(lease::role(&locks[0]), 3)],
        &|| Ok(()),
    )
    .unwrap()
    .unwrap();
    assert!(applied.is_some());
    let (named, left): (String, i64) = db
        .with_connection(|conn| {
            conn.query_row(
                "SELECT actor || ' ' || run_id || ' ' || COALESCE(epoch, '-'),
                        (SELECT COUNT(*) FROM replica_writer)
                   FROM replica_outbox",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!((named.as_str(), left), ("dreamer 9 3", 0));
}
