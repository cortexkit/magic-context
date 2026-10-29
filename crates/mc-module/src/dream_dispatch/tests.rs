use super::context::*;
use super::dispatcher::*;
use super::domain_control::available;
use crate::config_parity::{
    ConfigResolveRequest, CoreConfig, CoreConfigResolver, ProtectedTokenTiers, TrustFlags,
};
use mc_store::dream_domain::DreamDomainLease;
use mc_store::dream_scheduler::{
    schedules::{RunOutcome, RunStatus, ScheduleState, TaskConfig, TaskName},
    SqliteDreamScheduler,
};
use mc_store::parity_schema_manifest::*;
use mc_store::McStore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct Effects {
    path: PathBuf,
    store: Arc<McStore>,
    gate: bool,
    gate_error: bool,
    lose_lease: bool,
    charge: bool,
}

impl TaskExecutor for Effects {
    fn operational_tasks(&self) -> &[TaskName] {
        &[TaskName::Classify]
    }
    async fn gate(
        &mut self,
        _: TaskName,
        _: &StoreScope,
        _: &ScheduleState,
        _: &str,
    ) -> Result<super::dispatcher::GateDecision, String> {
        if self.gate_error {
            Err("fixture read failed".into())
        } else {
            Ok(self.gate.into())
        }
    }
    async fn run(&mut self, context: &TaskContext) -> RunOutcome {
        assert_eq!(context.task, TaskName::Classify);
        assert!(context.config.activated);
        if self.charge {
            let usage = crate::dream_runner::Usage {
                input: 100,
                cache_read: 20,
                cache_write: 3,
                output: 999,
            };
            assert_eq!(
                context
                    .control
                    .charge_usage("child:message", &usage, true, false)
                    .unwrap(),
                mc_store::dream_scheduler::budget::BudgetAction::Continue
            );
            context
                .control
                .charge_usage("child:message", &usage, true, false)
                .unwrap();
        }
        if self.lose_lease {
            self.store
                .release_dream_domain(&context.domain_lease)
                .unwrap();
            self.store
                .acquire_dream_domain(&context.domain_lease.key, "successor", context.now_ms())
                .unwrap()
                .unwrap();
            assert_eq!(context.check_control(), Err(ControlError::LeaseLost));
        }
        let mut db = Connection::open(&self.path).unwrap();
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        let write = (|| {
            mc_store::dream_domain::require_tx(&tx, &context.domain_lease, context.now_ms())?;
            tx.execute("INSERT INTO dream_state(key,value) VALUES ('fixture-effect','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1", [])?;
            Ok::<_, rusqlite::Error>(())
        })();
        if self.lose_lease {
            assert!(write.is_err());
            return RunOutcome::new(RunStatus::Failed);
        }
        write.unwrap();
        tx.commit().unwrap();
        RunOutcome::new(RunStatus::Completed)
    }
}

fn fixture() -> (Dispatcher<Effects>, tempfile::TempDir, Arc<TestClock>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            &include_str!("../../../mc-store/testdata/context_schema/schema.sql")
                .replace(":applied_at", "1"),
        )
        .unwrap();
    let store =
        Arc::new(McStore::open(&crate::dev_descriptor_at(dir.path().to_str().unwrap())).unwrap());
    store.install_context_domain(Arc::new(
        mc_store::SqliteContextDomain::open(&path).unwrap(),
    ));
    let scheduler =
        Arc::new(SqliteDreamScheduler::open(dir.path().join("scheduler.db"), true).unwrap());
    let clock = Arc::new(TestClock(AtomicI64::new(60_000)));
    let effects = Effects {
        path: dir.path().join("context.db"),
        store: store.clone(),
        gate: true,
        gate_error: false,
        lose_lease: false,
        charge: false,
    };
    (
        Dispatcher {
            store,
            scheduler,
            scope: StoreScope {
                project: ProjectId("project".into()),
                session: SessionId("session".into()),
                generation: Generation(1),
            },
            config: Arc::new(CapturedConfig {
                activated: true,
                route: crate::McModuleConfig::default(),
                effective: json!({}),
                harness: "opencode".into(),
                directory: dir.path().into(),
            }),
            clock: clock.clone(),
            executor: effects,
        },
        dir,
        clock,
    )
}

fn config() -> TaskConfig {
    TaskConfig {
        task: TaskName::Classify,
        schedule: "* * * * *".into(),
        has_input: true,
        legacy_last_run_at: None,
    }
}

fn effects(path: &std::path::Path) -> i64 {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM dream_state WHERE key='fixture-effect'",
            [],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
        .unwrap_or(0)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InteropStep {
    name: String,
    op: String,
    holder: String,
    key: String,
    now_ms: i64,
    generation: Option<u64>,
    result: Option<bool>,
    rows: BTreeMap<String, String>,
    owns: BTreeMap<String, BTreeMap<String, bool>>,
}

fn interop_steps() -> Vec<InteropStep> {
    serde_json::from_str(include_str!("../../testdata/dream_domain_interop.json")).unwrap()
}

fn interop_step(name: &str) -> InteropStep {
    interop_steps()
        .into_iter()
        .find(|s| s.name == name)
        .unwrap()
}

fn dream_rows(path: &std::path::Path) -> BTreeMap<String, String> {
    Connection::open(path)
        .unwrap()
        .prepare("SELECT key,value FROM dream_state")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

// Install a committed foreign-runtime snapshot, not a second lease algorithm.
// The colocated TS test proves these exact rows using the real TS lease functions.
fn install_interop_rows(path: &std::path::Path, step: &InteropStep) {
    let mut db = Connection::open(path).unwrap();
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    tx.execute("DELETE FROM dream_state", []).unwrap();
    for (key, value) in &step.rows {
        tx.execute(
            "INSERT INTO dream_state(key,value) VALUES(?1,?2)",
            params![key, value],
        )
        .unwrap();
    }
    tx.commit().unwrap();
}

#[test]
fn rust_replays_shared_dream_domain_interop_fixture() {
    let (dispatcher, _dir, clock) = fixture();
    let mut leases = BTreeMap::<(String, String), DreamDomainLease>::new();
    let steps = interop_steps();
    assert_eq!(steps.len(), 17);
    // Both native replayers use the same holder labels and fixed expected rows.
    // Expiry advances the clock without deleting the durable lease identity.
    for step in steps {
        clock.0.store(step.now_ms, Ordering::SeqCst);
        let identity = (step.key.clone(), step.holder.clone());
        match step.op.as_str() {
            "acquire" => {
                let lease = dispatcher
                    .store
                    .acquire_dream_domain(&step.key, &step.holder, step.now_ms)
                    .unwrap();
                assert_eq!(Some(lease.is_some()), step.result, "{}", step.name);
                assert_eq!(
                    lease.as_ref().map(|l| l.generation),
                    step.generation,
                    "{}",
                    step.name
                );
                if let Some(lease) = lease {
                    leases.insert(identity, lease);
                }
            }
            "renew" => {
                let mut lease = leases[&identity].clone();
                lease.generation = step.generation.unwrap();
                assert_eq!(
                    Some(
                        dispatcher
                            .store
                            .renew_dream_domain(&lease, step.now_ms)
                            .unwrap()
                    ),
                    step.result,
                    "{}",
                    step.name
                );
            }
            "release" => {
                dispatcher
                    .store
                    .release_dream_domain(&leases[&identity])
                    .unwrap();
            }
            "expire" => {}
            other => panic!("unknown fixture operation: {other}"),
        }
        assert_eq!(
            dream_rows(&dispatcher.executor.path),
            step.rows,
            "{}",
            step.name
        );
        for (key, holders) in step.owns {
            for (holder, expected) in holders {
                let absent = DreamDomainLease {
                    key: key.clone(),
                    holder: holder.clone(),
                    generation: 0,
                    expires_at_ms: 0,
                };
                let lease = leases.get(&(key.clone(), holder)).unwrap_or(&absent);
                assert_eq!(
                    dispatcher
                        .store
                        .owns_dream_domain(lease, step.now_ms)
                        .unwrap(),
                    expected,
                    "{}: {} / {}",
                    step.name,
                    lease.key,
                    lease.holder
                );
            }
        }
    }
}

#[tokio::test]
async fn ts_fixture_domain_blocks_rust_canonical_dispatch_until_release() {
    let (mut dispatcher, _dir, clock) = fixture();
    let key = TaskName::Classify.lease_key(&dispatcher.scope.project.0);
    let held = interop_step("ts-acquire-memory");
    assert_eq!(key, held.key);
    install_interop_rows(&dispatcher.executor.path, &held);
    clock.0.store(held.now_ms, Ordering::SeqCst);
    assert!(dispatcher
        .store
        .owns_dream_domain(
            &DreamDomainLease {
                key: key.clone(),
                holder: "typescript".into(),
                generation: held.generation.unwrap(),
                expires_at_ms: 0
            },
            held.now_ms
        )
        .unwrap());
    let outcome = dispatcher
        .manual(&config(), "manual", TIMEOUT, Cancellation::default())
        .await;
    assert_eq!(outcome, DispatchOutcome::Refused("domain_busy".into()));
    assert!(available(
        dispatcher
            .scheduler
            .schedule(&dispatcher.scope, TaskName::Classify)
    )
    .unwrap()
    .is_none());
    assert_eq!(effects(&dispatcher.executor.path), 0);
    let released = interop_step("ts-release-memory");
    install_interop_rows(&dispatcher.executor.path, &released);
    clock.0.store(released.now_ms, Ordering::SeqCst);
    assert!(dispatcher
        .store
        .owns_dream_domain(
            &DreamDomainLease {
                key: "dreaming".into(),
                holder: "rust".into(),
                generation: 1,
                expires_at_ms: 0
            },
            released.now_ms
        )
        .unwrap());
    assert_eq!(
        dispatcher
            .manual(&config(), "manual", TIMEOUT, Cancellation::default())
            .await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    assert_eq!(effects(&dispatcher.executor.path), 1);
    let rows = dream_rows(&dispatcher.executor.path);
    assert_eq!(rows.get("dreaming_lease_holder"), Some(&"rust".into()));
    assert!(!rows.keys().any(|k| k.starts_with("lease:dreaming:")));
}

#[tokio::test]
async fn rust_dispatch_domain_blocks_foreign_fixture_holder_until_completion() {
    struct ForeignProbe(Effects);
    impl TaskExecutor for ForeignProbe {
        fn operational_tasks(&self) -> &[TaskName] {
            self.0.operational_tasks()
        }
        async fn gate(
            &mut self,
            _: TaskName,
            _: &StoreScope,
            _: &ScheduleState,
            _: &str,
        ) -> Result<super::dispatcher::GateDecision, String> {
            Ok(true.into())
        }
        async fn run(&mut self, context: &TaskContext) -> RunOutcome {
            assert!(self
                .0
                .store
                .owns_dream_domain(&context.domain_lease, context.now_ms())
                .unwrap());
            assert!(self
                .0
                .store
                .acquire_dream_domain(&context.domain_lease.key, "typescript", context.now_ms())
                .unwrap()
                .is_none());
            self.0.run(context).await
        }
    }
    let (dispatcher, _dir, _) = fixture();
    let mut dispatcher = Dispatcher {
        store: dispatcher.store,
        scheduler: dispatcher.scheduler,
        scope: dispatcher.scope,
        config: dispatcher.config,
        clock: dispatcher.clock,
        executor: ForeignProbe(dispatcher.executor),
    };
    assert_eq!(
        dispatcher
            .manual(&config(), "rust-first", TIMEOUT, Cancellation::default())
            .await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    assert_eq!(effects(&dispatcher.executor.0.path), 1);
    assert!(dispatcher
        .store
        .acquire_dream_domain(
            &TaskName::Classify.lease_key("project"),
            "typescript",
            dispatcher.clock.now_ms()
        )
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn due_tick_and_manual_replay_run_once_across_reopen() {
    let (mut dispatcher, dir, clock) = fixture();
    assert!(dispatcher
        .tick(&[config()], true, TIMEOUT)
        .await
        .unwrap()
        .is_empty());
    clock.0.store(120_000, Ordering::SeqCst);
    assert_eq!(
        dispatcher.tick(&[config()], true, TIMEOUT).await.unwrap(),
        vec![(
            TaskName::Classify,
            DispatchOutcome::Finished(RunStatus::Completed)
        )]
    );
    assert!(dispatcher
        .tick(&[config()], true, TIMEOUT)
        .await
        .unwrap()
        .is_empty());
    dispatcher.executor.charge = true;
    assert_eq!(
        dispatcher
            .manual(&config(), "command", TIMEOUT, Cancellation::default())
            .await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    dispatcher.scheduler =
        Arc::new(SqliteDreamScheduler::open(dir.path().join("scheduler.db"), true).unwrap());
    assert!(matches!(
        dispatcher
            .manual(&config(), "command", TIMEOUT, Cancellation::default())
            .await,
        DispatchOutcome::Refused(_)
    ));
    assert_eq!(effects(&dispatcher.executor.path), 2);
    let db = Connection::open(dir.path().join("scheduler.db")).unwrap();
    let spent: u64 = db.query_row("SELECT json_extract(state,'$.spent_tokens') FROM dream_runs WHERE invocation='command'", [], |r| r.get(0)).unwrap();
    assert_eq!(spent, 123);
}

#[tokio::test]
async fn lease_loss_aborts_effects_without_advancing_schedule() {
    let (mut dispatcher, _dir, _) = fixture();
    available(
        dispatcher
            .scheduler
            .plan_due(&dispatcher.scope, &[config()], 60_000, true),
    )
    .unwrap();
    let before = available(
        dispatcher
            .scheduler
            .schedule(&dispatcher.scope, TaskName::Classify),
    )
    .unwrap();
    dispatcher.executor.lose_lease = true;
    assert_eq!(
        dispatcher
            .manual(&config(), "lost", TIMEOUT, Cancellation::default())
            .await,
        DispatchOutcome::Aborted(ControlError::LeaseLost)
    );
    assert_eq!(effects(&dispatcher.executor.path), 0);
    assert_eq!(
        available(
            dispatcher
                .scheduler
                .schedule(&dispatcher.scope, TaskName::Classify)
        )
        .unwrap(),
        before
    );
}

#[tokio::test]
async fn unavailable_and_due_manual_gate_matrix_preserve_schedules() {
    let (mut dispatcher, _dir, clock) = fixture();
    let mut unsupported = config();
    unsupported.task = TaskName::EvaluateSmartNotes;
    assert_eq!(
        dispatcher
            .manual(&unsupported, "missing", TIMEOUT, Cancellation::default())
            .await,
        DispatchOutcome::Unavailable
    );
    assert!(dispatcher
        .tick(&[unsupported.clone()], true, TIMEOUT)
        .await
        .unwrap()
        .is_empty());
    assert!(available(
        dispatcher
            .scheduler
            .schedule(&dispatcher.scope, unsupported.task)
    )
    .unwrap()
    .is_none());
    available(
        dispatcher
            .scheduler
            .plan_due(&dispatcher.scope, &[unsupported.clone()], 0, true),
    )
    .unwrap();
    let before = available(
        dispatcher
            .scheduler
            .schedule(&dispatcher.scope, unsupported.task),
    )
    .unwrap();
    unsupported.schedule.clear();
    dispatcher
        .tick(&[unsupported], true, TIMEOUT)
        .await
        .unwrap();
    assert_eq!(
        available(
            dispatcher
                .scheduler
                .schedule(&dispatcher.scope, TaskName::EvaluateSmartNotes)
        )
        .unwrap(),
        before
    );
    assert!(dispatcher
        .tick(&[config()], false, TIMEOUT)
        .await
        .unwrap()
        .is_empty());
    assert!(available(
        dispatcher
            .scheduler
            .schedule(&dispatcher.scope, TaskName::Classify)
    )
    .unwrap()
    .is_none());
    dispatcher.tick(&[config()], true, TIMEOUT).await.unwrap();
    let before = available(
        dispatcher
            .scheduler
            .schedule(&dispatcher.scope, TaskName::Classify),
    )
    .unwrap();
    clock.0.store(120_000, Ordering::SeqCst);
    dispatcher.executor.gate_error = true;
    assert!(matches!(
        &dispatcher.tick(&[config()], true, TIMEOUT).await.unwrap()[0].1,
        DispatchOutcome::Refused(_)
    ));
    assert_eq!(
        available(
            dispatcher
                .scheduler
                .schedule(&dispatcher.scope, TaskName::Classify)
        )
        .unwrap(),
        before
    );
    dispatcher.executor.gate_error = false;
    dispatcher.executor.gate = false;
    assert!(matches!(
        &dispatcher.tick(&[config()], true, TIMEOUT).await.unwrap()[0].1,
        DispatchOutcome::Refused(_)
    ));
    let after = available(
        dispatcher
            .scheduler
            .schedule(&dispatcher.scope, TaskName::Classify),
    )
    .unwrap()
    .unwrap();
    assert_eq!(after.last_status, Some(RunStatus::Skipped));
    assert_eq!(after.last_run_at, None);
    let mut disabled = config();
    disabled.schedule.clear();
    assert_eq!(
        dispatcher
            .manual(
                &disabled,
                "force-disabled",
                TIMEOUT,
                Cancellation::default()
            )
            .await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    // The unsupported task above has no production executor either.
    assert!(!OPERATIONAL_TASKS.contains(&TaskName::EvaluateSmartNotes));
}

struct FlipResolver {
    on: AtomicBool,
    flip_to: bool,
    reads: AtomicUsize,
}
impl CoreConfigResolver for FlipResolver {
    fn availability(&self) -> Availability {
        Availability::Available
    }
    fn resolve(&self, _: &ConfigResolveRequest) -> CapabilityResult<CoreConfig> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let effective = crate::McModuleConfig {
            rust_background_enabled: self.on.swap(self.flip_to, Ordering::SeqCst),
            ..Default::default()
        };
        CapabilityResult::Available {
            value: CoreConfig {
                effective,
                generation: Generation(1),
                settings: json!({}),
                warnings: vec![],
                trust: TrustFlags::default(),
                protected_token_tiers: ProtectedTokenTiers::default(),
            },
        }
    }
}

#[test]
fn captured_on_to_off_tick_dispatches_and_off_to_on_tick_dispatches_none() {
    for on in [true, false] {
        let (mut dispatcher, _dir, clock) = fixture();
        available(
            dispatcher
                .scheduler
                .plan_due(&dispatcher.scope, &[config()], 60_000, true),
        )
        .unwrap();
        clock.0.store(120_000, Ordering::SeqCst);
        let path = dispatcher.executor.path.clone();
        let resolver = Arc::new(FlipResolver {
            on: AtomicBool::new(on),
            flip_to: !on,
            reads: AtomicUsize::new(0),
        });
        let input = crate::background::ConfigInput {
            resolver: resolver.clone(),
            request: ConfigResolveRequest {
                user_config_path: String::new(),
                project_root: "/fixture".into(),
                generation: Generation(1),
            },
        };
        let joined = crate::background::dreamer_tick(input, move |unit| {
            dispatcher.config =
                unit.captured_dream_config("opencode".into(), dispatcher.config.directory.clone());
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(dispatcher.tick(&[config()], true, TIMEOUT))
                .unwrap()
        })
        .unwrap()
        .join()
        .unwrap()
        .unwrap();
        assert_eq!(resolver.reads.load(Ordering::SeqCst), 1);
        assert_eq!(resolver.on.load(Ordering::SeqCst), !on);
        if on {
            assert_eq!(
                joined.unwrap(),
                vec![(
                    TaskName::Classify,
                    DispatchOutcome::Finished(RunStatus::Completed)
                )]
            );
        } else {
            assert!(joined.is_none());
        }
        assert_eq!(effects(&path), i64::from(on));
    }
}

#[tokio::test]
async fn budget_cancellation_deadline_and_failed_heartbeat_stop_run_control() {
    struct Probe {
        store: Arc<McStore>,
        scheduler: Arc<SqliteDreamScheduler>,
        mode: u8,
    }
    impl TaskExecutor for Probe {
        fn operational_tasks(&self) -> &[TaskName] {
            &[TaskName::Classify]
        }
        async fn gate(
            &mut self,
            _: TaskName,
            _: &StoreScope,
            _: &ScheduleState,
            _: &str,
        ) -> Result<super::dispatcher::GateDecision, String> {
            Ok(true.into())
        }
        async fn run(&mut self, context: &TaskContext) -> RunOutcome {
            match self.mode {
                0 => {
                    let usage = crate::dream_runner::Usage {
                        input: 2_500_000,
                        ..Default::default()
                    };
                    assert_eq!(
                        context
                            .control
                            .charge_usage("budget", &usage, false, false)
                            .unwrap(),
                        mc_store::dream_scheduler::budget::BudgetAction::Stop
                    );
                    assert_eq!(context.check_control(), Err(ControlError::BudgetExhausted));
                    assert!(context.control.refuse_tool().unwrap().is_some());
                }
                1 => context.cancellation.cancel(),
                2 => {
                    std::future::pending::<()>().await;
                }
                3 => {
                    let control = super::domain_control::DomainControl::new(
                        self.store.clone(),
                        self.scheduler.clone(),
                        context.domain_lease.clone(),
                        context.task_lease.clone(),
                        context.cancellation.clone(),
                        context.clock.clone(),
                        context.deadline_ms,
                    );
                    control.heartbeat().unwrap();
                    self.store
                        .release_dream_domain(&context.domain_lease)
                        .unwrap();
                    self.store
                        .acquire_dream_domain(
                            &context.domain_lease.key,
                            "replacement",
                            context.now_ms(),
                        )
                        .unwrap()
                        .unwrap();
                    assert_eq!(control.heartbeat(), Err(ControlError::LeaseLost));
                    assert_eq!(control.check_control(), Err(ControlError::LeaseLost));
                }
                _ => unreachable!(),
            }
            RunOutcome::new(RunStatus::Failed)
        }
    }
    for mode in 0..4 {
        let (d, _dir, _) = fixture();
        let mut d = Dispatcher {
            executor: Probe {
                store: d.store.clone(),
                scheduler: d.scheduler.clone(),
                mode,
            },
            store: d.store,
            scheduler: d.scheduler,
            scope: d.scope,
            config: d.config,
            clock: d.clock,
        };
        let timeout = if mode == 2 {
            Duration::from_millis(5)
        } else {
            TIMEOUT
        };
        let result = d
            .manual(&config(), "control", timeout, Cancellation::default())
            .await;
        let expected = match mode {
            0 => DispatchOutcome::Finished(RunStatus::Failed),
            1 => DispatchOutcome::Aborted(ControlError::Cancelled),
            2 => DispatchOutcome::Aborted(ControlError::Deadline),
            _ => DispatchOutcome::Aborted(ControlError::LeaseLost),
        };
        assert_eq!(result, expected);
        let now = d.clock.now_ms();
        // The task worker has stopped, so a new holder can immediately acquire.
        let lease = d
            .store
            .acquire_dream_domain(&TaskName::Classify.lease_key("project"), "after", now)
            .unwrap();
        if mode != 3 {
            assert!(lease.is_some());
        }
    }
}

/// The TypeScript dreamer's row for classify with the slot at 60 000 due, as the
/// Rust tick sees it before planning (it adopts that row first).
fn due_typescript_row(d: &Dispatcher<Effects>, path: &std::path::Path) {
    Connection::open(path)
        .unwrap()
        .execute(
            "INSERT INTO task_schedule_state(project_path,task,next_due_at,schedule,retry_count) VALUES('project','classify-memories',60000,'* * * * *',0)",
            [],
        )
        .unwrap();
    let legacy = d
        .store
        .legacy_task_schedule("project", TaskName::Classify)
        .unwrap()
        .unwrap();
    assert!(available(d.scheduler.adopt_legacy(&d.scope, &config(), &legacy)).unwrap());
}

/// A TypeScript dreamer with no ck-mc module client never asks which tasks Rust
/// owns; it plans from its own row as soon as it can take the domain lease. So
/// the Rust dispatcher must have written its progress into that row before the
/// lease is released, not after. SQLite triggers record the order of the row
/// write and the release of the lease's holder row.
#[tokio::test]
async fn rust_writes_the_typescript_row_before_releasing_the_domain() {
    let (mut d, dir, _) = fixture();
    let path = dir.path().join("context.db");
    due_typescript_row(&d, &path);
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE write_order(seq INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL);
             CREATE TRIGGER typescript_row_written AFTER UPDATE ON task_schedule_state
               BEGIN INSERT INTO write_order(event) VALUES('row:' || NEW.next_due_at); END;
             CREATE TRIGGER domain_released AFTER DELETE ON dream_state WHEN OLD.key LIKE 'lease:%:holder'
               BEGIN INSERT INTO write_order(event) VALUES('released'); END;",
        )
        .unwrap();
    let report = d.tick(&[config()], true, TIMEOUT).await.unwrap();
    assert_eq!(
        report,
        vec![(
            TaskName::Classify,
            DispatchOutcome::Finished(RunStatus::Completed)
        )]
    );
    assert_eq!(effects(&path), 1);
    let db = Connection::open(&path).unwrap();
    let events: Vec<String> = db
        .prepare("SELECT event FROM write_order ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(events, ["row:120000", "released"]);
}

/// The TypeScript dreamer runs the slot after the Rust tick planned it and
/// before the dispatcher takes the domain lease. The dispatcher re-reads the
/// TypeScript row once it holds the lease, so it does not run the slot again.
#[tokio::test]
async fn a_slot_typescript_ran_after_rust_planned_it_is_not_run_again() {
    struct Hooked {
        calls: AtomicUsize,
        path: PathBuf,
    }
    impl Clock for Hooked {
        fn now_ms(&self) -> i64 {
            // Reading 1 plans the tick; reading 2 is taken just before the
            // dispatcher asks for the domain lease. In between, TypeScript runs the
            // slot: it advances its row to the next minute and releases its lease.
            if self.calls.fetch_add(1, Ordering::SeqCst) == 1 {
                Connection::open(&self.path)
                    .unwrap()
                    .execute(
                        "UPDATE task_schedule_state SET last_run_at=60000,next_due_at=120000,last_status='completed' WHERE project_path='project' AND task='classify-memories'",
                        [],
                    )
                    .unwrap();
            }
            60_000
        }
    }
    let (mut d, dir, _) = fixture();
    let path = dir.path().join("context.db");
    due_typescript_row(&d, &path);
    d.clock = Arc::new(Hooked {
        calls: AtomicUsize::new(0),
        path: path.clone(),
    });
    let report = d.tick(&[config()], true, TIMEOUT).await.unwrap();
    assert_eq!(
        report,
        vec![(
            TaskName::Classify,
            DispatchOutcome::Refused("not_due".into())
        )]
    );
    assert_eq!(effects(&path), 0);
    assert_eq!(
        available(d.scheduler.schedule(&d.scope, TaskName::Classify))
            .unwrap()
            .unwrap()
            .next_due_at,
        Some(120_000)
    );
}
