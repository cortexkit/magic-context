use super::dreamer::schedule;
use super::fixture_tests::{Fixture, EMPTY, FORMS, FUTURE, PROJECT, ZONE};
use super::*;

#[test]
fn a_schedule_takes_a_form_only_when_its_cron_is_exactly_that_form() {
    let zone = Some(ZONE);
    for (cron, form) in [
        ("0 * * * *", json!({"every":"hour","minute":0})),
        ("45 * * * *", json!({"every":"hour","minute":45})),
        ("0 6 * * *", json!({"every":"day","at":"06:00"})),
        ("5 23 * * *", json!({"every":"day","at":"23:05"})),
        (
            "30 4 * * 1-5",
            json!({"every":"week","days":["mon","tue","wed","thu","fri"],"at":"04:30"}),
        ),
        // Sunday is 0 or 7, and the days come out in week order.
        (
            "0 4 * * 0",
            json!({"every":"week","days":["sun"],"at":"04:00"}),
        ),
        (
            "0 4 * * 7,3,1",
            json!({"every":"week","days":["mon","wed","sun"],"at":"04:00"}),
        ),
        (
            "0 9 * * 5-7",
            json!({"every":"week","days":["fri","sat","sun"],"at":"09:00"}),
        ),
    ] {
        let mut expected = form;
        expected["time_zone"] = json!(ZONE);
        assert_eq!(schedule(cron, zone), expected, "{cron}");
    }
    for cron in [
        "*/15 * * * *",
        "0 */2 * * *",
        "0,30 * * * *",
        "0 6,18 * * *",
        "0 6 1 * *",
        "0 6 * 1 *",
        "0 6 * * 1/2",
        "0 6 * * */2",
        "0 6 * * 5-1",
        "60 * * * *",
        "0 24 * * *",
        "0 6 * * 8",
        "* * * * *",
        "0 6 * *",
        "",
    ] {
        assert_eq!(
            schedule(cron, zone),
            json!({"cron": cron, "time_zone": ZONE}),
            "{cron}"
        );
    }
    // A machine whose zone can't be named sends none.
    assert_eq!(
        schedule("0 6 * * *", None),
        json!({"every":"day","at":"06:00"})
    );
}

#[test]
fn status_shows_the_lock_each_task_and_its_last_run() {
    let fixture = Fixture::new();
    let mut replica = fixture.replica();
    let status = replica
        .read("dreamer.status", &json!({"project":PROJECT}))
        .unwrap();
    assert_eq!(status["enabled"], true);
    assert_eq!(status["config_source"], "user");
    assert_eq!(status["health"], "ok");
    assert_eq!(
        status["lock"],
        json!({"task":"swe:classify-memories","since":1_700_007_200_000_i64,"run_id":3})
    );
    assert_eq!(
        status["tasks"][0],
        json!({
            "task": "swe:classify-memories",
            "kind": "classify-memories",
            "enabled": true,
            "schedule": {"every": "day", "at": "06:00", "time_zone": ZONE},
            "next_due_at": FUTURE,
            "overdue": false,
            "last": {"status": "applied", "at": 1_700_003_690_000_i64},
            "failures_in_a_row": 0,
        })
    );
    assert_eq!(
        status["tasks"][1],
        json!({
            "task": "swe:compress-cues",
            "kind": "compress-cues",
            "enabled": true,
            "schedule": {"cron": "15 */2 * * *", "time_zone": ZONE},
            "next_due_at": 1_700_010_000_000_i64,
            "overdue": true,
            "last": {"status": "failed", "at": 1_700_000_060_000_i64, "failure_class": "model", "error": "provider returned 500"},
            "failures_in_a_row": 1,
        })
    );
    let forms = replica
        .read("dreamer.status", &json!({"project":FORMS}))
        .unwrap();
    assert_eq!(forms["tasks"][0]["schedule"]["every"], "hour");
    assert_eq!(forms["tasks"][1]["schedule"]["every"], "week");
    // No run and no profile in this process: the kind is not known.
    assert!(forms["tasks"][0].get("kind").is_none());
    assert!(forms["tasks"][0].get("last").is_none());
    assert!(forms.get("lock").is_none());
    let empty = replica
        .read("dreamer.status", &json!({"project":EMPTY}))
        .unwrap();
    assert_eq!(
        (empty["tasks"].clone(), empty["health"].clone()),
        (json!([]), json!("ok"))
    );
    assert_eq!(
        replica
            .read("dreamer.status", &json!({"project":"pj-never"}))
            .unwrap_err()
            .code,
        "project_unknown"
    );
}

#[test]
fn health_is_failing_after_three_failures_and_waiting_while_an_account_limit_holds() {
    let fixture = Fixture::new();
    let conn = fixture.context();
    conn.execute_batch(&format!(
        "UPDATE dream_schedules SET last_status = 'waiting', last_error = 'rate_limited'
           WHERE owner_id = '{PROJECT}' AND task = 'swe:classify-memories';
         INSERT INTO dream_task_runs (id, task, kind, level, owner_id, profile, started_at, ended_at, outcome, error, batches_json)
           VALUES (4, 'swe:classify-memories', 'classify-memories', 'project', '{PROJECT}', 'memory-swe',
                   1700009000000, 1700009001000, 'waiting', 'rate_limited',
                   '[{{\"wait_until\":{FUTURE},\"code\":\"rate_limited\"}}]');
         DELETE FROM dream_locks;"
    ))
    .unwrap();
    let mut replica = fixture.replica();
    let status = replica
        .read("dreamer.status", &json!({"project":PROJECT}))
        .unwrap();
    assert_eq!(status["health"], "waiting");
    assert_eq!(status["tasks"][0]["waiting_until"], FUTURE);
    assert_eq!(
        status["tasks"][0]["last"],
        json!({"status":"waiting","at":1_700_009_001_000_i64,"error":"rate_limited"})
    );
    assert!(status.get("lock").is_none());
    conn.execute(
        "UPDATE dream_schedules SET failures = 3 WHERE task = 'swe:compress-cues'",
        [],
    )
    .unwrap();
    let status = replica
        .read("dreamer.status", &json!({"project":PROJECT}))
        .unwrap();
    assert_eq!(status["health"], "failing");
    // A failure with no failed run behind it: the store refused the lock.
    conn.execute_batch(
        "UPDATE dream_schedules SET last_status = 'failed', last_error = 'locking the project failed: busy'
           WHERE task = 'swe:classify-memories'",
    )
    .unwrap();
    let status = replica
        .read("dreamer.status", &json!({"project":PROJECT}))
        .unwrap();
    assert_eq!(status["tasks"][0]["last"]["failure_class"], "store");
    // A lapsed lock is no lock.
    conn.execute_batch(&format!(
        "INSERT INTO dream_locks VALUES ('project', '{PROJECT}', 'other', 'swe:compress-cues', 1, 2)"
    ))
    .unwrap();
    assert!(replica
        .read("dreamer.status", &json!({"project":PROJECT}))
        .unwrap()
        .get("lock")
        .is_none());
}

#[test]
fn status_takes_kinds_and_switches_from_the_profile_the_engine_holds() {
    let fixture = Fixture::new();
    let db = crate::context_db::ContextDb::open(&fixture.dir.path().join("context.db")).unwrap();
    let engine = Arc::new(crate::dreamer::engine::Engine::new(
        "ck-mc:test",
        crate::dreamer::tasks(),
    ));
    let profile = Arc::new(crate::memory_profile::prompt_profile(None).unwrap());
    let mut settings = crate::dreamer::engine::Settings::default();
    settings
        .schedules
        .insert("compress-cues".into(), String::new());
    engine.see_project(&db, EMPTY, "/nowhere", profile, &settings, 1);
    assert_eq!(
        engine.declared(EMPTY, "swe:classify-memories"),
        Some(("classify-memories".into(), true))
    );
    assert_eq!(engine.declared(EMPTY, "swe:no-such-task"), None);
    assert_eq!(engine.declared("pj-unseen", "swe:classify-memories"), None);
    let mut replica = fixture.replica();
    replica.apps.attached.as_mut().unwrap().dreamer = Some(engine);
    let status = replica
        .read("dreamer.status", &json!({"project":EMPTY}))
        .unwrap();
    let tasks = status["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 4);
    assert_eq!(tasks[0]["kind"], "classify-memories");
    assert_eq!(tasks[0]["schedule"]["every"], "day");
    // The person switched compress-cues off: it has no schedule.
    assert_eq!(
        (tasks[1]["kind"].clone(), tasks[1]["enabled"].clone()),
        (json!("compress-cues"), json!(false))
    );
    assert!(tasks[1].get("schedule").is_none());
    assert!(tasks[1].get("next_due_at").is_none());
    assert_eq!(tasks[2]["kind"], "curate");
    assert_eq!(tasks[2]["schedule"]["every"], "week");
    assert_eq!(
        (tasks[3]["kind"].clone(), tasks[3]["enabled"].clone()),
        (json!("map-memories"), json!(true))
    );
}

#[test]
fn runs_page_newest_first_with_what_each_run_changed() {
    let fixture = Fixture::new();
    let mut replica = fixture.replica();
    let first = replica
        .read("dreamer.runs", &json!({"project":PROJECT,"limit":2}))
        .unwrap();
    let runs = first["runs"].as_array().unwrap();
    assert_eq!(
        runs.iter().map(|run| run["id"].clone()).collect::<Vec<_>>(),
        [json!(3), json!(2)]
    );
    assert_eq!(runs[0]["outcome"], "running");
    assert!(runs[0].get("ended_at").is_none() && runs[0].get("duration_ms").is_none());
    assert_eq!(
        runs[1],
        json!({
            "id": 2,
            "task": "swe:classify-memories",
            "kind": "classify-memories",
            "started_at": 1_700_003_600_000_i64,
            "ended_at": 1_700_003_690_000_i64,
            "duration_ms": 90_000,
            "outcome": "applied",
            "tokens": {"input": 5400, "output": 800},
            "proposed": 3,
            "applied": 1,
            "changes": {"written": 1, "merged": 0, "archived": 0},
            "models": ["anthropic/claude-haiku-4-5", "openai/gpt-5-mini"],
        })
    );
    let second = replica
        .read(
            "dreamer.runs",
            &json!({"project":PROJECT,"limit":2,"cursor":first["next"]}),
        )
        .unwrap();
    assert_eq!(second["runs"][0]["id"], 1);
    assert_eq!(second["runs"][0]["failure_class"], "model");
    assert!(second.get("next").is_none());
    let filtered = replica
        .read(
            "dreamer.runs",
            &json!({"project":PROJECT,"task":"swe:compress-cues"}),
        )
        .unwrap();
    assert_eq!(filtered["runs"].as_array().unwrap().len(), 1);
    assert_eq!(
        replica
            .read("dreamer.runs", &json!({"project":EMPTY}))
            .unwrap()["runs"],
        json!([])
    );
    assert_eq!(
        replica
            .read(
                "dreamer.runs",
                &json!({"project":PROJECT,"task":"swe:compress-cues","cursor":first["next"]})
            )
            .unwrap_err()
            .code,
        "bad_cursor"
    );
}

#[test]
fn a_runs_changes_count_merges_and_archives_and_every_failed_run_has_a_class() {
    let fixture = Fixture::new();
    let conn = fixture.context();
    let decision = json!({"writer":"dreamer:curate","rows":[
        {"memoryId":5,"before":{"status":"active","supersededByMemoryId":null},"after":{"status":"archived","supersededByMemoryId":6}},
        {"memoryId":6,"before":{"status":"active","content":"a"},"after":{"status":"active","content":"b"}},
        {"memoryId":8,"before":{"status":"active"},"after":{"status":"archived"}},
        {"memoryId":9,"before":null,"after":{"status":"active"}},
        {"memoryId":10,"before":{"status":"active"},"after":{"status":"active"}}
    ]});
    conn.execute_batch(&format!(
        "INSERT INTO dream_task_runs (id, task, kind, level, owner_id, profile, started_at, ended_at, outcome, error)
           VALUES (5, 'swe:curate', 'curate', 'project', '{PROJECT}', 'memory-swe', 1700020000000, 1700020001000, 'lock_lost', 'the project''s lock passed to another writer'),
                  (6, 'swe:curate', 'curate', 'project', '{PROJECT}', 'memory-swe', 1700030000000, 1700030001000, 'interrupted', NULL),
                  (50, 'swe:curate', 'curate', 'project', '{PROJECT}', 'memory-swe', 1, 2, 'applied', NULL);
         INSERT INTO memory_journal (project_path, decision_key, operation, receipt_json, applied_at, before_json)
           VALUES ('{PROJECT}', 'dream-run:5:curate:0', 'curate', '{{}}', 1, '{decision}'),
                  ('{PROJECT}', 'dream-run:50:curate:0', 'curate', '{{}}', 1, '{decision}');"
    ))
    .unwrap();
    let mut replica = fixture.replica();
    let runs = replica
        .read(
            "dreamer.runs",
            &json!({"project":PROJECT,"task":"swe:curate"}),
        )
        .unwrap();
    assert_eq!(runs["runs"][0]["failure_class"], "interrupted");
    assert_eq!(runs["runs"][1]["failure_class"], "lock_lost");
    assert_eq!(
        runs["runs"][1]["changes"],
        json!({"written": 2, "merged": 1, "archived": 1})
    );
    // Run 5's key range doesn't reach run 50's rows.
    let run = replica.read("dreamer.run", &json!({"id":5})).unwrap();
    assert_eq!(run["run"]["changed_memory_ids"], json!([5, 6, 8, 9]));
}

#[test]
fn one_run_shows_its_batches_dropped_proposals_and_changed_memories() {
    let fixture = Fixture::new();
    let mut replica = fixture.replica();
    let run = replica.read("dreamer.run", &json!({"id":2})).unwrap()["run"].clone();
    assert_eq!(run["project"], PROJECT);
    assert_eq!(
        run["batches"],
        json!([
            {"model":"anthropic/claude-haiku-4-5","runner":"thalamus-harness","child_session":"ck-dream-2.0","tokens":{"input":3000,"output":500}},
            {"model":"openai/gpt-5-mini","runner":"thalamus-harness","child_session":"ck-dream-2.1","tokens":{"input":2400,"output":300}}
        ])
    );
    assert_eq!(run["dropped"][0]["memory_id"], 4);
    assert_eq!(run["dropped"][1]["memory_id"], 7);
    assert!(run["dropped"][1]["reason"]
        .as_str()
        .unwrap()
        .starts_with("memory 7: shareable=true"));
    assert_eq!(run["changed_memory_ids"], json!([3]));
    let running = replica.read("dreamer.run", &json!({"id":3})).unwrap()["run"].clone();
    assert_eq!(
        (
            running["batches"].clone(),
            running["dropped"].clone(),
            running["changed_memory_ids"].clone()
        ),
        (json!([]), json!([]), json!([]))
    );
    assert_eq!(
        replica
            .read("dreamer.run", &json!({"id":99}))
            .unwrap_err()
            .code,
        "run_not_found"
    );
}
