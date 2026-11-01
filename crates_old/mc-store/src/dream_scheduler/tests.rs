use super::*;
use budget::{BudgetAction, TokenBudget};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::sync::{Arc, Barrier};

fn oracle() -> Value {
    serde_json::from_str(include_str!("fixtures/oracle.json")).unwrap()
}
fn available<T: std::fmt::Debug>(value: CapabilityResult<T>) -> T {
    match value {
        CapabilityResult::Available { value } => value,
        other => panic!("{other:?}"),
    }
}
fn refused<T: std::fmt::Debug>(value: CapabilityResult<T>, code: &str) {
    match value {
        CapabilityResult::Unavailable { reason } => assert_eq!(reason.code, code),
        other => panic!("expected {code}, got {other:?}"),
    }
}
fn scope(project: &str) -> StoreScope {
    StoreScope {
        project: ProjectId(project.into()),
        session: SessionId("session".into()),
        generation: Generation(1),
    }
}
fn config(task: TaskName) -> TaskConfig {
    TaskConfig {
        task,
        schedule: "* * * * *".into(),
        has_input: true,
        legacy_last_run_at: None,
    }
}
fn request(project: &str, task: TaskName, invocation: &str, now: i64) -> DreamClaimRequest {
    let kind = match task {
        TaskName::Map => BackgroundTask::Map,
        TaskName::Verify | TaskName::VerifyBroad => BackgroundTask::Verify,
        TaskName::ReviewUserMemories => BackgroundTask::ReviewUserMemories,
        TaskName::MaintainDocs => BackgroundTask::MaintainDocs,
        _ => BackgroundTask::Curate,
    };
    DreamClaimRequest {
        scope: scope(project),
        task: kind,
        domain: task.lease_key(project),
        invocation: InvocationId(invocation.into()),
        now_ms: now,
        lease_ms: 120_000,
        token_budget: 100,
        manual_force: false,
    }
}
fn finish(lease: DreamLease, now: i64) -> DreamFinishRequest {
    DreamFinishRequest {
        lease,
        now_ms: now,
        spent_tokens: 0,
        succeeded: true,
    }
}
fn scenario(name: &str) {
    let o = oracle();
    let scenario = o["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == name)
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("dream.sqlite");
    for (index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
        // Every step uses a new handle to prove schedule and claim durability.
        let store = SqliteDreamScheduler::open(&path, true).unwrap();
        let now = step["time"].as_i64().unwrap();
        let cfg = TaskConfig {
            task: TaskName::Verify,
            schedule: step["schedule"].as_str().unwrap_or("* * * * *").into(),
            has_input: step["input"].as_bool().unwrap_or(true),
            legacy_last_run_at: None,
        };
        let op = step["op"].as_str().unwrap();
        let mut executed = 0;
        let mut slots = Vec::new();
        let planned = if op != "manual" {
            available(store.plan_due(
                &scope("git:fixture"),
                std::slice::from_ref(&cfg),
                now,
                step["memory_enabled"].as_bool().unwrap_or(true),
            ))
        } else {
            Vec::new()
        };
        if op == "plan" {
            slots = planned.iter().map(|d| d.scheduled_at).collect()
        }
        if op != "plan" {
            let force = op == "manual";
            let mut req = request(
                "git:fixture",
                TaskName::Verify,
                &format!("run-{index}"),
                now,
            );
            req.manual_force = force;
            if force || !planned.is_empty() {
                if !force && !step["gate"].as_bool().unwrap_or(true) {
                    available(store.skip_due(
                        &req.scope,
                        TaskName::Verify,
                        planned[0].scheduled_at,
                        now,
                    ));
                } else {
                    match store.claim_task(&req, TaskName::Verify, force.then_some(&cfg), |_| {
                        step["post_gate"].as_bool().unwrap_or(true)
                    }) {
                        CapabilityResult::Available { value: lease } => {
                            executed += 1;
                            let status: RunStatus = serde_json::from_value(
                                step["outcome"]["status"]
                                    .as_str()
                                    .map(|s| json!(s))
                                    .unwrap_or(json!("completed")),
                            )
                            .unwrap();
                            let mut outcome = RunOutcome::new(status);
                            outcome.transient =
                                step["outcome"]["transient"].as_bool().unwrap_or(false);
                            outcome.error = step["outcome"][if status == RunStatus::Skipped {
                                "detail"
                            } else {
                                "error"
                            }]
                            .as_str()
                            .map(str::to_string);
                            outcome.task_state_json = step["outcome"]["schedulePatch"]
                                ["taskStateJson"]
                                .as_str()
                                .map(str::to_string);
                            outcome.retrospective_watermark_ms = step["outcome"]["schedulePatch"]
                                .get("retrospectiveWatermarkMs")
                                .map(Value::as_i64);
                            available(store.finish_task(
                                &finish(lease, now + step["advance_ms"].as_i64().unwrap_or(0)),
                                &outcome,
                            ));
                        }
                        other => refused(other, "gate_closed"),
                    }
                }
            }
        }
        let actual = json!({"state":available(store.schedule(&scope("git:fixture"),TaskName::Verify)),"executed":executed,"due":slots});
        assert_eq!(actual, step["expected"], "{name} step {index}");
    }
}

#[test]
fn oracle_due_skip_complete() {
    scenario("due_skip_complete")
}
#[test]
fn oracle_retry_cap() {
    scenario("retry_cap")
}
#[test]
fn oracle_manual_disabled() {
    scenario("manual_disabled")
}
#[test]
fn oracle_reconcile() {
    scenario("reconcile")
}
#[test]
fn oracle_watermark_success_and_failure() {
    scenario("watermark_success_and_failure")
}

#[test]
fn oracle_budget() {
    for c in oracle()["budget_cases"].as_array().unwrap() {
        let mut guard = TokenBudget::new(c["budget"].as_u64().unwrap()).unwrap();
        for op in c["ops"].as_array().unwrap() {
            let action = if let Some(charge) = op["charge"].as_array() {
                serde_json::to_value(
                    guard
                        .charge(
                            charge[0].as_u64().unwrap(),
                            charge[1].as_u64().unwrap(),
                            charge[2].as_u64().unwrap(),
                            charge[3].as_bool().unwrap(),
                            charge[4].as_bool().unwrap(),
                        )
                        .unwrap(),
                )
                .unwrap()
            } else if op["finalize"].as_bool().unwrap_or(false) {
                serde_json::to_value(guard.finalize()).unwrap()
            } else {
                guard
                    .refuse_tool()
                    .map(|(message, stopped)| json!({"message":message,"hardStopped":stopped}))
                    .unwrap_or(Value::Null)
            };
            assert_eq!(
                json!({"action":action,"spent":guard.spent,"finalize_fired":guard.finalize_fired,"refused_calls":guard.refused_calls,"hard_stopped":guard.hard_stopped()}),
                op["expected"],
                "{}",
                c["name"]
            );
        }
    }
    assert!(TokenBudget::new(0).is_err());
    assert!(TokenBudget::new(9_007_199_254_740_992).is_err());
    assert!(TokenBudget::new(100)
        .unwrap()
        .charge(u64::MAX, 0, 0, false, true)
        .is_err());
}

#[test]
fn oracle_registry() {
    let expected = &oracle()["registry"];
    let actual: Vec<_> = schedules::CANONICAL_TASKS.into_iter().map(|task| json!({"task":task,"domain":task.lease_key("git:fixture"),"budget":task.default_budget()})).collect();
    assert_eq!(json!(actual), *expected);
}

#[test]
fn oracle_cron_utc() {
    // Non-UTC vectors run in their own process, so no test mutates global TZ.
    if std::env::var("TZ").as_deref() != Ok("UTC") {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "dream_scheduler::tests::oracle_cron_utc",
                "--nocapture",
            ])
            .env("TZ", "UTC")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "UTC child failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    for c in oracle()["cron"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["zone"] == "UTC")
    {
        assert_eq!(
            json!(cron::next_due(
                c["expression"].as_str().unwrap(),
                c["after"].as_i64().unwrap(),
                c["consumed"].as_i64()
            )
            .unwrap()),
            c["expected"],
            "{c}"
        );
    }
}

#[test]
fn oracle_cron_dst() {
    if std::env::var("DREAM_DST_CHILD").is_err() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "dream_scheduler::tests::oracle_cron_dst",
                "--nocapture",
            ])
            .env("DREAM_DST_CHILD", "1")
            .env("TZ", "America/New_York")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "DST child failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    for c in oracle()["cron"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["zone"] == "America/New_York")
    {
        assert_eq!(
            json!(cron::next_due(
                c["expression"].as_str().unwrap(),
                c["after"].as_i64().unwrap(),
                c["consumed"].as_i64()
            )
            .unwrap()),
            c["expected"],
            "{c}"
        );
    }
}

#[test]
fn oracle_lease_takeover() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("scheduler.sqlite");
    let mut leases = std::collections::HashMap::new();
    for s in oracle()["lease_steps"].as_array().unwrap() {
        let store = SqliteDreamScheduler::open(&path, true).unwrap();
        let now = s["time"].as_i64().unwrap();
        let holder = s["holder"].as_str().unwrap();
        let op = s["op"].as_str().unwrap();
        let result = if op == "acquire" {
            let mut req = request("git:fixture", TaskName::Verify, holder, now);
            req.manual_force = true;
            let cfg = config(TaskName::Verify);
            let result = store.claim_task(&req, TaskName::Verify, Some(&cfg), |_| true);
            if let CapabilityResult::Available { value } = &result {
                leases.insert(holder.to_string(), value.clone());
            }
            Some(matches!(result, CapabilityResult::Available { .. }))
        } else if op == "refresh" || op == "renew" {
            let result = store.heartbeat(leases.get(holder).unwrap(), now);
            if let CapabilityResult::Available { value } = &result {
                leases.insert(holder.to_string(), value.clone());
            }
            Some(matches!(result, CapabilityResult::Available { .. }))
        } else {
            // A stale executor's abort must not release its replacement's lease.
            let _ = store.abandon(leases.get(holder).unwrap());
            None
        };
        assert_eq!(json!(result), s["expected"]["allowed"], "{s}");
        store
            .read(|db| {
                let token: Option<String> = db
                    .query_row("SELECT token FROM dream_leases", [], |r| r.get(0))
                    .optional()?;
                let actual_holder = token.and_then(|t| {
                    leases
                        .iter()
                        .find(|(_, l)| l.token == t)
                        .map(|(holder, _)| holder.clone())
                });
                assert_eq!(json!(actual_holder), s["expected"]["holder"], "{s}");
                assert_eq!(
                    leases::busy(db, "memory:git:fixture", now)?,
                    s["expected"]["active"].as_bool().unwrap()
                );
                Ok(())
            })
            .unwrap();
    }
}

#[test]
fn activation_off_is_side_effect_free() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("scheduler.sqlite");
    let store = SqliteDreamScheduler::open(&path, false).unwrap();
    assert!(
        available(store.plan_due(&scope("git:p"), &[config(TaskName::Verify)], 60000, true))
            .is_empty()
    );
    let req = request("git:p", TaskName::Verify, "off", 60000);
    refused(store.claim(&req), "activation_off");
    let lease = DreamLease {
        scope: req.scope,
        invocation: req.invocation,
        token: "unclaimed".into(),
        expires_at_ms: 120000,
    };
    refused(store.heartbeat(&lease, 60000), "activation_off");
    refused(
        store.finish(&finish(lease.clone(), 60000)),
        "activation_off",
    );
    refused(
        store.update_budget(&lease, 60000, |budget| {
            budget.charge(100, 0, 0, false, true)
        }),
        "activation_off",
    );
    assert!(!path.exists());
}

#[test]
fn scope_fences_stale_heartbeat_finish_and_budget() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDreamScheduler::open(root.path().join("dream.sqlite"), true).unwrap();
    let req = request("git:p", TaskName::Verify, "one", 60000);
    available(store.plan_due(&req.scope, &[config(TaskName::Verify)], 0, true));
    let lease = available(store.claim(&req));
    let mut foreign = lease.clone();
    foreign.scope.session.0 = "other-session".into();
    refused(store.heartbeat(&foreign, 60001), "superseded_token");
    foreign = lease.clone();
    foreign.scope.generation = Generation(2);
    refused(store.finish(&finish(foreign, 60001)), "superseded_token");
    let mut second = request("git:p", TaskName::Map, "two", 180000);
    second.manual_force = true;
    let next = available(store.claim_task(
        &second,
        TaskName::Map,
        Some(&config(TaskName::Map)),
        |_| true,
    ));
    refused(store.heartbeat(&lease, 180001), "superseded_token");
    refused(
        store.finish(&finish(lease.clone(), 180001)),
        "superseded_token",
    );
    refused(store.token_budget(&lease, 180001), "superseded_token");
    assert_eq!(available(store.token_budget(&next, 180001)).spent, 0);
    let state = available(store.schedule(&req.scope, TaskName::Verify)).unwrap();
    assert_eq!(state.last_run_at, None);
    assert_eq!(state.next_due_at, Some(60000));
}

#[test]
fn budget_survives_restart_and_completed_overspend() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("dream.sqlite");
    let store = SqliteDreamScheduler::open(&path, true).unwrap();
    let req = request("git:p", TaskName::Verify, "run", 60000);
    available(store.plan_due(&req.scope, &[config(TaskName::Verify)], 0, true));
    let lease = available(store.claim(&req));
    assert_eq!(
        available(store.update_budget(&lease, 60001, |b| b.charge(80, 0, 0, false, true))),
        BudgetAction::Finalize
    );
    drop(store);
    let store = SqliteDreamScheduler::open(&path, true).unwrap();
    assert!(available(store.token_budget(&lease, 60002)).finalize_fired);
    assert_eq!(
        available(store.update_budget(&lease, 60003, |b| b.charge(30, 0, 0, true, true))),
        BudgetAction::Continue
    );
    available(store.finish(&DreamFinishRequest {
        lease,
        now_ms: 60004,
        spent_tokens: 110,
        succeeded: true,
    }));
    assert_eq!(
        available(store.schedule(&req.scope, TaskName::Verify))
            .unwrap()
            .last_status,
        Some(RunStatus::Completed)
    );
}

#[test]
fn domains_are_project_scoped_except_user_memories() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDreamScheduler::open(root.path().join("dream.sqlite"), true).unwrap();
    for task in [TaskName::Verify, TaskName::ReviewUserMemories] {
        let mut a = request("git:a", task, task.as_str(), 60000);
        a.manual_force = true;
        let mut b = request("git:b", task, task.as_str(), 60000);
        b.manual_force = true;
        available(store.claim_task(&a, task, Some(&config(task)), |_| true));
        let result = store.claim_task(&b, task, Some(&config(task)), |_| true);
        if task == TaskName::ReviewUserMemories {
            refused(result, "lease_busy")
        } else {
            available(result);
        }
    }
    assert!(available(store.schedule(&scope("git:foreign"), TaskName::Verify)).is_none());
}

#[test]
fn concurrent_handles_admit_one_domain_holder() {
    let root = tempfile::tempdir().unwrap();
    let path = Arc::new(root.path().join("dream.sqlite"));
    let barrier = Arc::new(Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|i| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let store = SqliteDreamScheduler::open(&*path, true).unwrap();
                let mut req = request("git:p", TaskName::Verify, &format!("run-{i}"), 60000);
                req.manual_force = true;
                barrier.wait();
                matches!(
                    store.claim_task(
                        &req,
                        TaskName::Verify,
                        Some(&config(TaskName::Verify)),
                        |_| true
                    ),
                    CapabilityResult::Available { .. }
                )
            })
        })
        .collect();
    assert_eq!(
        workers
            .into_iter()
            .map(|w| w.join().unwrap() as u32)
            .sum::<u32>(),
        1
    );
}

#[test]
fn refuses_context_database_without_migration() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("context.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE session_meta(cache_epoch INTEGER); INSERT INTO session_meta VALUES(7);",
    )
    .unwrap();
    assert!(matches!(
        SqliteDreamScheduler::open(&path, true),
        Err(Error::Refused("not_scheduler_database"))
    ));
    assert_eq!(
        db.query_row("SELECT cache_epoch FROM session_meta", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        7
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name LIKE 'dream_%'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn busy_and_early_claims_leave_due_state_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDreamScheduler::open(root.path().join("dream.sqlite"), true).unwrap();
    let mut req = request("git:p", TaskName::Verify, "first", 59999);
    available(store.plan_due(
        &req.scope,
        &[config(TaskName::Verify), config(TaskName::Map)],
        0,
        true,
    ));
    refused(store.claim(&req), "not_due");
    req.now_ms = 60000;
    let lease = available(store.claim(&req));
    assert_eq!(available(store.claim(&req)), lease);
    let prior = available(store.schedule(&req.scope, TaskName::Map));
    let other = request("git:p", TaskName::Map, "second", 60000);
    refused(store.claim(&other), "lease_busy");
    assert_eq!(available(store.schedule(&req.scope, TaskName::Map)), prior);
    available(store.finish(&finish(lease, 60001)));
    assert_eq!(
        available(store.schedule(&req.scope, TaskName::Verify))
            .unwrap()
            .last_run_at,
        Some(60000)
    );
    let next = available(store.claim(&other));
    available(store.finish(&finish(next.clone(), 60002)));
    refused(store.finish(&finish(next, 60003)), "already_finished");
    refused(
        store.skip_due(&req.scope, TaskName::Verify, 60000, 120000),
        "not_due",
    );
}

#[test]
fn forced_manual_honors_busy_lease_and_ignores_closed_gate() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("dream.sqlite");
    let store = SqliteDreamScheduler::open(&path, true).unwrap();
    let mut req = request("git:p", TaskName::Verify, "manual", 0);
    req.manual_force = true;
    let mut disabled = config(TaskName::Verify);
    disabled.schedule = "".into();
    disabled.has_input = false;
    let lease = available(
        store.claim_task(&req, TaskName::Verify, Some(&disabled), |_| {
            panic!("forced gate evaluated")
        }),
    );
    let mut other = request("git:p", TaskName::Map, "other", 1);
    other.manual_force = true;
    refused(
        store.claim_task(&other, TaskName::Map, Some(&config(TaskName::Map)), |_| {
            true
        }),
        "lease_busy",
    );
    let seeded = available(store.schedule(&req.scope, TaskName::Map)).unwrap();
    assert_eq!(seeded.next_due_at, Some(60000));
    assert_eq!(seeded.last_status, None);
    // Another unit reading off cannot alter the already-started on unit.
    let off = SqliteDreamScheduler::open(&path, false).unwrap();
    refused(off.finish(&finish(lease.clone(), 2)), "activation_off");
    available(store.finish(&finish(lease, 3)));
    assert_eq!(
        available(store.schedule(&req.scope, TaskName::Verify))
            .unwrap()
            .next_due_at,
        None
    );
    available(
        store.claim_task(&other, TaskName::Map, Some(&config(TaskName::Map)), |_| {
            true
        }),
    );
}

#[test]
fn post_lease_gate_read_error_does_not_consume_slot() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDreamScheduler::open(root.path().join("dream.sqlite"), true).unwrap();
    let req = request("git:p", TaskName::Verify, "run", 60000);
    available(store.plan_due(&req.scope, &[config(TaskName::Verify)], 0, true));
    let prior = available(store.schedule(&req.scope, TaskName::Verify));
    refused(
        store.claim_task_checked(&req, TaskName::Verify, None, |_| {
            Err(Error::Refused("gate_read_busy"))
        }),
        "gate_read_busy",
    );
    assert_eq!(
        available(store.schedule(&req.scope, TaskName::Verify)),
        prior
    );
    available(store.claim(&req));
}

#[test]
fn oracle_manual_wait_policy() {
    for case in oracle()["manual_wait_cases"].as_array().unwrap() {
        let root = tempfile::tempdir().unwrap();
        let store = SqliteDreamScheduler::open(root.path().join("dream.sqlite"), true).unwrap();
        let cfg = config(TaskName::Verify);
        let mut blocker = request("git:fixture", TaskName::Map, "blocker", 0);
        blocker.manual_force = true;
        let held = available(store.claim_task(
            &blocker,
            TaskName::Map,
            Some(&config(TaskName::Map)),
            |_| true,
        ));
        let wait = schedules::ManualLeaseWait::new(0);
        let mut now = 0;
        let mut delays = Vec::new();
        let (mut ran, mut deferred) = (0, 0);
        loop {
            let mut req = request("git:fixture", TaskName::Verify, "manual", now);
            req.manual_force = true;
            match store.claim_task(&req, TaskName::Verify, Some(&cfg), |_| true) {
                CapabilityResult::Available { value: lease } => {
                    ran += 1;
                    available(store.finish(&finish(lease, now)));
                    break;
                }
                other => refused(other, "lease_busy"),
            }
            let Some(delay) = wait.retry_delay_ms(now) else {
                deferred += 1;
                break;
            };
            delays.push(delay);
            now += delay as i64;
            if case["release_at"].as_i64().is_some_and(|time| now >= time) {
                available(store.abandon(&held));
            }
        }
        assert_eq!(
            json!({"release_at":case["release_at"],"delays":delays,"ran":ran,"deferred":deferred,"state":available(store.schedule(&scope("git:fixture"),TaskName::Verify))}),
            *case
        );
    }
}

#[test]
fn gate_callback_holds_no_store_lock() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDreamScheduler::open(root.path().join("dream.sqlite"), true).unwrap();
    let req = request("git:p", TaskName::Verify, "run", 60000);
    available(store.plan_due(&req.scope, &[config(TaskName::Verify)], 0, true));
    available(store.claim_task(&req, TaskName::Verify, None, |state| {
        drop(
            store
                .db
                .as_ref()
                .unwrap()
                .try_lock()
                .expect("gate runs without connection mutex"),
        );
        assert_eq!(
            available(store.schedule(&req.scope, TaskName::Verify)).as_ref(),
            Some(state)
        );
        true
    }));
}
