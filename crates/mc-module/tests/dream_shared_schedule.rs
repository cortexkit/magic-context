//! The TypeScript dreamer and the Rust dreamer share one context.db and never run
//! the same task twice in one cron period, nor at the same time.
//!
//! After the mode-2 removal no TypeScript host has a ck-mc module client, so the
//! TypeScript dreamer never reads which tasks Rust owns: it plans every task from
//! its own `task_schedule_state` row. What keeps the two apart is the store:
//!
//! - both take the same dream-domain lease before running a memory task;
//! - while it holds that lease, the Rust dispatcher adopts the TypeScript row's
//!   progress before claiming and writes its own progress into that row before
//!   releasing (`Dispatcher::dispatch`);
//! - the TypeScript scheduler writes its row before releasing the lease, and once
//!   it holds the lease it skips a planned slot whose `next_due_at` has moved on.
//!
//! The TypeScript side here is the real scheduler (`runDueTasksForProject`) run by
//! Bun from `fixtures/dream-shared-schedule-ts.ts`. The Rust side is the real
//! `Dispatcher` with a recording executor, wrapped the way the Rust tick
//! (`dream_dispatch::tick`) wraps it: adopt the TypeScript row, tick, publish. The
//! published list decides only which tasks reach that dispatcher.
//!
//! Requires Bun on PATH. Every file lives under a throwaway root; the Bun child gets
//! that root as HOME, TMPDIR and XDG dirs.

use mc_module::dream_dispatch::context::{CapturedConfig, Clock, TaskContext};
use mc_module::dream_dispatch::dispatcher::{DispatchOutcome, Dispatcher, TaskExecutor};
use mc_store::dream_scheduler::schedules::{
    RunOutcome, RunStatus, ScheduleState, TaskConfig, TaskName,
};
use mc_store::dream_scheduler::SqliteDreamScheduler;
use mc_store::parity_schema_manifest::{
    CapabilityResult, Generation, ProjectId, SessionId, StoreScope,
};
use mc_store::McStore;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const SCHEDULE: &str = "0 * * * *";
const HOUR_MS: i64 = 3_600_000;
const TASK: TaskName = TaskName::Curate;

fn wall_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// A hook to run once, and the clock reading (1-based) it runs on.
type ClockHook = (usize, Box<dyn FnOnce() + Send>);

/// A wall clock that can run one hook on a chosen call, so a test can act at an
/// exact point inside the dispatcher (its second reading is taken just before it
/// asks for the domain lease).
#[derive(Default)]
struct HookClock {
    calls: AtomicUsize,
    hook: Mutex<Option<ClockHook>>,
}

impl Clock for HookClock {
    fn now_ms(&self) -> i64 {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let hook = {
            let mut slot = self.hook.lock().unwrap();
            match slot.take() {
                Some((at, hook)) if at == call => Some(hook),
                other => {
                    *slot = other;
                    None
                }
            }
        };
        if let Some(hook) = hook {
            hook();
        }
        wall_ms()
    }
}

/// Records each Rust run in `cross_runtime_runs`; `during_run` lets a test act
/// while the run holds the domain lease.
struct Recorder {
    context_db: PathBuf,
    during_run: Option<Box<dyn FnMut() + Send>>,
}

impl TaskExecutor for Recorder {
    fn operational_tasks(&self) -> &[TaskName] {
        &[TASK]
    }
    async fn gate(
        &mut self,
        _: TaskName,
        _: &StoreScope,
        _: &ScheduleState,
        _: &str,
    ) -> Result<mc_store::dream_scheduler::GateDecision, String> {
        Ok(true.into())
    }
    async fn run(&mut self, _: &TaskContext) -> RunOutcome {
        let started = wall_ms();
        if let Some(during) = self.during_run.as_mut() {
            during();
        }
        rusqlite::Connection::open(&self.context_db)
            .unwrap()
            .execute(
                "INSERT INTO cross_runtime_runs(runtime, started_at, finished_at) VALUES ('rust', ?1, ?2)",
                rusqlite::params![started, wall_ms()],
            )
            .unwrap();
        RunOutcome::new(RunStatus::Completed)
    }
}

struct Shared {
    root: tempfile::TempDir,
    project: String,
    context_db: PathBuf,
    store: Arc<McStore>,
    scheduler: Arc<SqliteDreamScheduler>,
    clock: Arc<HookClock>,
    /// The slot both runtimes see as due when the scenario starts.
    slot: i64,
}

fn scope(project: &str) -> StoreScope {
    StoreScope {
        project: ProjectId(project.to_owned()),
        session: SessionId("session".into()),
        generation: Generation(1),
    }
}

impl Shared {
    /// A store whose TypeScript row for curate has the current hour's slot due,
    /// and one active memory so the curate gate passes on both sides.
    fn new() -> Self {
        // Stay clear of the next hourly slot, which would legitimately make a
        // second run due in the middle of a scenario.
        let into_hour = wall_ms().rem_euclid(HOUR_MS);
        if into_hour > HOUR_MS - 90_000 {
            std::thread::sleep(Duration::from_millis((HOUR_MS - into_hour + 1_000) as u64));
        }
        let base = std::env::temp_dir().join("magic-context/i5-stage-f2");
        std::fs::create_dir_all(&base).unwrap();
        let root = tempfile::Builder::new()
            .prefix("shared-schedule-")
            .tempdir_in(base)
            .unwrap();
        let project = "git:shared-schedule".to_owned();
        let store_path = root.path().join("store.db");
        let store = Arc::new(
            McStore::open_for_test(&cortexkit_store_types::StorageDescriptor {
                module_id: "magic-context".into(),
                storage_namespace: "mc_cache".into(),
                isolation: cortexkit_store_types::Isolation::Module,
                backend: cortexkit_store_types::StorageBackend::Sqlite {
                    path: store_path.to_string_lossy().into_owned(),
                },
            })
            .unwrap(),
        );
        let context_db = store_path.with_file_name("context.db");
        let slot = wall_ms() - wall_ms().rem_euclid(HOUR_MS);
        let content = "The cache drops its least recently used entry first.";
        rusqlite::Connection::open(&context_db)
            .unwrap()
            .execute_batch(&format!(
                "CREATE TABLE cross_runtime_runs(runtime TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL);
                 INSERT INTO task_schedule_state(project_path,task,last_run_at,next_due_at,schedule,retry_count)
                   VALUES('{project}','curate',NULL,{slot},'{SCHEDULE}',0);
                 INSERT INTO memories(id,project_path,category,content,normalized_hash,source_session_id,first_seen_at,created_at,updated_at,last_seen_at,metadata_json)
                   VALUES(1,'{project}','ARCHITECTURE','{content}','{}','source',1,1,1,1,'{{}}');",
                mc_store::compute_normalized_memory_hash(content)
            ))
            .unwrap();
        let scheduler =
            Arc::new(SqliteDreamScheduler::open(root.path().join("scheduler.db"), true).unwrap());
        Self {
            root,
            project,
            context_db,
            store,
            scheduler,
            clock: Arc::default(),
            slot,
        }
    }

    fn signal_dir(&self, name: &str) -> PathBuf {
        let dir = self.root.path().join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Start the TypeScript dreamer's pass in `mode` (see the fixture).
    fn spawn_typescript(&self, mode: &str, signal_dir: &Path) -> Child {
        let home = self.root.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        Command::new("bun")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/dream-shared-schedule-ts.ts"
            ))
            .arg(&self.context_db)
            .arg(&self.project)
            .arg(SCHEDULE)
            .arg(mode)
            .arg(signal_dir)
            .env("NODE_ENV", "test")
            .env("TZ", "UTC")
            .env("HOME", &home)
            .env("TMPDIR", &home)
            .env("XDG_DATA_HOME", home.join("data"))
            .env("XDG_CONFIG_HOME", home.join("config"))
            .env("XDG_CACHE_HOME", home.join("cache"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the shared-schedule test requires Bun on PATH")
    }

    fn typescript_pass(&self) {
        finish(self.spawn_typescript("pass", &self.signal_dir("pass")));
    }

    fn dispatcher(&self, during_run: Option<Box<dyn FnMut() + Send>>) -> Dispatcher<Recorder> {
        Dispatcher {
            store: self.store.clone(),
            scheduler: self.scheduler.clone(),
            scope: scope(&self.project),
            config: Arc::new(CapturedConfig {
                activated: true,
                route: mc_module::config::McModuleConfig::default(),
                effective: json!({}),
                harness: "opencode".into(),
                directory: self.root.path().to_path_buf(),
            }),
            clock: self.clock.clone(),
            executor: Recorder {
                context_db: self.context_db.clone(),
                during_run,
            },
        }
    }

    fn config(&self) -> TaskConfig {
        TaskConfig {
            task: TASK,
            schedule: SCHEDULE.into(),
            has_input: true,
            legacy_last_run_at: self
                .store
                .legacy_task_schedule(&self.project, TASK)
                .unwrap()
                .and_then(|l| l.last_run_at),
        }
    }

    /// The step the Rust tick takes before planning: adopt the TypeScript row.
    fn adopt(&self) {
        if let Some(legacy) = self
            .store
            .legacy_task_schedule(&self.project, TASK)
            .unwrap()
        {
            let _ = self
                .scheduler
                .adopt_legacy(&scope(&self.project), &self.config(), &legacy);
        }
    }

    /// One Rust tick as `dream_dispatch::tick` runs it: adopt, tick, publish.
    fn rust_tick(
        &self,
        during_run: Option<Box<dyn FnMut() + Send>>,
    ) -> Vec<(TaskName, DispatchOutcome)> {
        self.adopt();
        let config = self.config();
        let mut dispatcher = self.dispatcher(during_run);
        let report = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(dispatcher.tick(&[config], true, Duration::from_secs(60)))
            .unwrap();
        if let CapabilityResult::Available { value: Some(state) } =
            self.scheduler.schedule(&scope(&self.project), TASK)
        {
            self.store
                .publish_task_schedule(&self.project, TASK, &state)
                .unwrap();
        }
        report
    }

    /// Every run so far, in start order.
    fn runs(&self) -> Vec<(String, i64, i64)> {
        let db = rusqlite::Connection::open(&self.context_db).unwrap();
        let mut statement = db
            .prepare("SELECT runtime, started_at, finished_at FROM cross_runtime_runs ORDER BY started_at, rowid")
            .unwrap();
        statement
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn runtimes(&self) -> Vec<String> {
        self.runs()
            .into_iter()
            .map(|(runtime, _, _)| runtime)
            .collect()
    }

    /// Exactly one run in the slot, by `runtime`; no two runs overlapped; and the
    /// TypeScript row (which both runtimes plan from) points at the next slot.
    fn assert_one_run_by(&self, runtime: &str) {
        let runs = self.runs();
        assert_eq!(self.runtimes(), [runtime], "{runs:?}");
        for pair in runs.windows(2) {
            assert!(pair[0].2 <= pair[1].1, "runs overlapped: {runs:?}");
        }
        let row = self
            .store
            .legacy_task_schedule(&self.project, TASK)
            .unwrap()
            .unwrap();
        assert_eq!(row.next_due_at, Some(self.slot + HOUR_MS), "{row:?}");
    }
}

fn finish(child: Child) {
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "typescript dreamer failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn wait_for(path: &Path) {
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while !path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn finished(report: &[(TaskName, DispatchOutcome)]) -> bool {
    report
        .iter()
        .any(|(_, outcome)| matches!(outcome, DispatchOutcome::Finished(_)))
}

/// Rust runs the slot first; later TypeScript and Rust passes in the same period
/// run nothing.
#[test]
fn rust_first_then_typescript_runs_the_slot_once() {
    let shared = Shared::new();
    assert!(finished(&shared.rust_tick(None)));
    shared.typescript_pass();
    assert!(!finished(&shared.rust_tick(None)));
    shared.typescript_pass();
    shared.assert_one_run_by("rust");
}

/// TypeScript runs the slot first; a Rust tick (it adopts the TypeScript row
/// before planning) and another TypeScript pass run nothing.
#[test]
fn typescript_first_then_rust_runs_the_slot_once() {
    let shared = Shared::new();
    shared.typescript_pass();
    assert!(!finished(&shared.rust_tick(None)));
    shared.typescript_pass();
    shared.assert_one_run_by("typescript");
}

/// TypeScript runs the slot after the Rust tick planned it and before the
/// dispatcher takes the lease. The dispatcher re-reads the TypeScript row under
/// the lease and does not run the slot again.
#[test]
fn typescript_running_between_rust_planning_and_its_lease_is_not_repeated() {
    let shared = Shared::new();
    let pass = shared.spawn_typescript("pass", &shared.signal_dir("between"));
    let pass = Mutex::new(Some(pass));
    // Reading 1 plans the tick; reading 2 is taken just before the lease.
    *shared.clock.hook.lock().unwrap() = Some((
        2,
        Box::new(move || finish(pass.lock().unwrap().take().unwrap())),
    ));
    let report = shared.rust_tick(None);
    assert!(!finished(&report), "{report:?}");
    shared.assert_one_run_by("typescript");
}

/// A TypeScript pass planned the slot before Rust took over and ran it; when the
/// pass then takes the lease it sees the slot already run and skips it.
#[test]
fn a_typescript_pass_planned_before_rust_ran_the_slot_skips_it() {
    let shared = Shared::new();
    let signals = shared.signal_dir("pause");
    let paused = shared.spawn_typescript("pause", &signals);
    wait_for(&signals.join("planned"));
    assert!(finished(&shared.rust_tick(None)));
    std::fs::write(signals.join("go"), "").unwrap();
    finish(paused);
    shared.assert_one_run_by("rust");
}

/// TypeScript is mid-run (holding the lease) when Rust takes ownership: Rust is
/// refused the domain, and after TypeScript finishes Rust does not repeat it.
#[test]
fn a_typescript_run_in_flight_when_rust_takes_over_is_not_repeated() {
    let shared = Shared::new();
    let signals = shared.signal_dir("hold");
    let holding = shared.spawn_typescript("hold", &signals);
    wait_for(&signals.join("holding"));
    let report = shared.rust_tick(None);
    assert!(
        report
            .iter()
            .any(|(_, o)| *o == DispatchOutcome::Refused("domain_busy".into())),
        "{report:?}"
    );
    std::fs::write(signals.join("release"), "").unwrap();
    finish(holding);
    assert!(!finished(&shared.rust_tick(None)));
    shared.assert_one_run_by("typescript");
}

/// A TypeScript pass while Rust is mid-run finds the domain busy; a pass after
/// Rust finished finds the slot already run.
#[test]
fn a_typescript_pass_during_a_rust_run_waits_and_then_runs_nothing() {
    let shared = Shared::new();
    let context_db = shared.context_db.clone();
    let child_root = shared.root.path().to_path_buf();
    let project = shared.project.clone();
    let during: Box<dyn FnMut() + Send> = Box::new(move || {
        // One TypeScript scheduler pass, the same command `Shared::typescript_pass`
        // runs, started while this Rust run holds the domain lease.
        let home = child_root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let signals = child_root.join("during");
        std::fs::create_dir_all(&signals).unwrap();
        let child = Command::new("bun")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/dream-shared-schedule-ts.ts"
            ))
            .arg(&context_db)
            .arg(&project)
            .arg(SCHEDULE)
            .arg("pass")
            .arg(&signals)
            .env("NODE_ENV", "test")
            .env("TZ", "UTC")
            .env("HOME", &home)
            .env("TMPDIR", &home)
            .env("XDG_DATA_HOME", home.join("data"))
            .env("XDG_CONFIG_HOME", home.join("config"))
            .env("XDG_CACHE_HOME", home.join("cache"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        finish(child);
    });
    assert!(finished(&shared.rust_tick(Some(during))));
    shared.typescript_pass();
    shared.assert_one_run_by("rust");
}
