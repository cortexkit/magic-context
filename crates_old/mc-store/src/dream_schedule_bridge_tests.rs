//! Ownership of a task flips between the TypeScript and Rust schedulers inside one
//! cron period. The TypeScript side is modelled by its own rule (run once
//! `next_due_at` has passed, then move `next_due_at` past the slot it ran), applied
//! to its real `task_schedule_state` row; the Rust side is the real scheduler.

use crate::dream_scheduler::cron;
use crate::dream_scheduler::schedules::{
    LegacySchedule, RunOutcome, RunStatus, TaskConfig, TaskName,
};
use crate::dream_scheduler::SqliteDreamScheduler;
use crate::parity_schema_manifest::*;
use crate::McStore;
use rusqlite::params;

const SCHEDULE: &str = "0 * * * *";
const PROJECT: &str = "git:flip";
const TASK: TaskName = TaskName::Curate;

struct Fixture {
    _dir: tempfile::TempDir,
    store: McStore,
    scheduler: SqliteDreamScheduler,
    runs: Vec<(&'static str, i64)>,
}

fn fixture() -> Fixture {
    let root = std::env::temp_dir().join("magic-context/i5-stage-e");
    std::fs::create_dir_all(&root).unwrap();
    let dir = tempfile::Builder::new()
        .prefix("schedule-bridge-")
        .tempdir_in(root)
        .unwrap();
    let store = McStore::open_for_test(&cortexkit_store_types::StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: "mc_cache".into(),
        isolation: cortexkit_store_types::Isolation::Module,
        backend: cortexkit_store_types::StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into_owned(),
        },
    })
    .unwrap();
    let scheduler = SqliteDreamScheduler::open(dir.path().join("scheduler.db"), true).unwrap();
    Fixture {
        _dir: dir,
        store,
        scheduler,
        runs: Vec::new(),
    }
}

fn scope() -> StoreScope {
    StoreScope {
        project: ProjectId(PROJECT.into()),
        session: SessionId("session".into()),
        generation: Generation(1),
    }
}

fn available<T: std::fmt::Debug>(value: CapabilityResult<T>) -> T {
    match value {
        CapabilityResult::Available { value } => value,
        other => panic!("{other:?}"),
    }
}

fn slot_after(ms: i64) -> i64 {
    cron::next_due(SCHEDULE, ms, None).unwrap().unwrap()
}

impl Fixture {
    fn legacy(&self) -> Option<LegacySchedule> {
        self.store.legacy_task_schedule(PROJECT, TASK).unwrap()
    }

    fn seed_typescript(&self, next_due_at: i64, last_run_at: Option<i64>) {
        self.store
            .with_context_conn_for_test(|tx| {
                tx.execute(
                    "INSERT INTO task_schedule_state(project_path,task,last_run_at,next_due_at,schedule,retry_count) VALUES(?1,?2,?3,?4,?5,0)",
                    params![PROJECT, TASK.as_str(), last_run_at, next_due_at, SCHEDULE],
                )
            })
            .unwrap();
    }

    /// One TypeScript scheduler pass while it owns the task.
    fn typescript_pass(&mut self, now: i64) {
        let row = self.legacy().expect("typescript row");
        let Some(due) = row.next_due_at.filter(|due| now >= *due) else {
            return;
        };
        self.runs.push(("typescript", due));
        let next = cron::next_due(SCHEDULE, now, Some(due)).unwrap();
        self.store
            .with_context_conn_for_test(|tx| {
                tx.execute(
                    "UPDATE task_schedule_state SET last_run_at=?3,next_due_at=?4,last_status='completed' WHERE project_path=?1 AND task=?2",
                    params![PROJECT, TASK.as_str(), now, next],
                )
            })
            .unwrap();
    }

    /// One Rust tick while Rust owns the task: adopt the TypeScript progress,
    /// plan, run what is due, then hand the progress back.
    fn rust_pass(&mut self, now: i64, invocation: &str) {
        let legacy = self.legacy();
        let config = TaskConfig {
            task: TASK,
            schedule: SCHEDULE.into(),
            has_input: true,
            legacy_last_run_at: legacy.as_ref().and_then(|l| l.last_run_at),
        };
        if let Some(legacy) = &legacy {
            available(self.scheduler.adopt_legacy(&scope(), &config, legacy));
        }
        let due =
            available(
                self.scheduler
                    .plan_due(&scope(), std::slice::from_ref(&config), now, true),
            );
        for due in due {
            let lease = available(self.scheduler.claim_task(
                &DreamClaimRequest {
                    scope: scope(),
                    task: BackgroundTask::Curate,
                    domain: TASK.lease_key(PROJECT),
                    invocation: InvocationId(invocation.into()),
                    now_ms: now,
                    lease_ms: 120_000,
                    token_budget: 100,
                    manual_force: false,
                },
                TASK,
                None,
                |_| true,
            ));
            self.runs.push(("rust", due.scheduled_at));
            available(self.scheduler.finish_task(
                &DreamFinishRequest {
                    lease,
                    now_ms: now,
                    spent_tokens: 0,
                    succeeded: true,
                },
                &RunOutcome::new(RunStatus::Completed),
            ));
        }
        if let Some(state) = available(self.scheduler.schedule(&scope(), TASK)) {
            self.store
                .publish_task_schedule(PROJECT, TASK, &state)
                .unwrap();
        }
    }
}

/// Rust takes over a period TypeScript has not run yet: it runs the overdue slot
/// (no skip), and neither side runs it again across off and on flips.
#[test]
fn flip_on_off_on_runs_an_unrun_period_exactly_once() {
    let mut f = fixture();
    let base = slot_after(1_800_000_000_000);
    f.seed_typescript(base, None);
    let now = base + 60_000;
    f.rust_pass(now, "on-1");
    f.typescript_pass(now + 60_000);
    f.rust_pass(now + 120_000, "on-2");
    f.typescript_pass(now + 180_000);
    assert_eq!(f.runs, vec![("rust", base)], "one run in the period");
    let next = slot_after(base);
    assert_eq!(f.legacy().unwrap().next_due_at, Some(next));
    // The next period runs once, on whichever side owns it then.
    f.rust_pass(next + 60_000, "on-3");
    f.typescript_pass(next + 120_000);
    assert_eq!(f.runs, vec![("rust", base), ("rust", next)]);
}

/// TypeScript runs a period after Rust's row went stale: the Rust row adopts
/// that progress, so turning Rust back on does not repeat the run.
#[test]
fn flip_off_on_off_after_a_typescript_run_never_repeats_it() {
    let mut f = fixture();
    let first = slot_after(1_800_000_000_000);
    f.seed_typescript(first, None);
    // Rust owned the previous period and ran it.
    f.rust_pass(first + 60_000, "previous");
    let base = slot_after(first);
    assert_eq!(f.legacy().unwrap().next_due_at, Some(base));
    // Off: TypeScript runs this period.
    f.typescript_pass(base + 60_000);
    // On, off, on within the same period.
    f.rust_pass(base + 120_000, "on-1");
    f.typescript_pass(base + 180_000);
    f.rust_pass(base + 240_000, "on-2");
    assert_eq!(f.runs, vec![("rust", first), ("typescript", base)]);
    assert_eq!(
        available(f.scheduler.schedule(&scope(), TASK))
            .unwrap()
            .next_due_at,
        Some(slot_after(base))
    );
}

/// A TypeScript row computed from another schedule says nothing about this one,
/// and a TypeScript row that is further ahead is never moved back.
#[test]
fn adoption_and_publication_only_move_forward_on_the_same_schedule() {
    let f = fixture();
    let base = slot_after(1_800_000_000_000);
    let config = TaskConfig {
        task: TASK,
        schedule: SCHEDULE.into(),
        has_input: true,
        legacy_last_run_at: None,
    };
    let other = LegacySchedule {
        last_run_at: None,
        next_due_at: Some(base),
        schedule: Some("*/5 * * * *".into()),
    };
    assert!(!available(f.scheduler.adopt_legacy(
        &scope(),
        &config,
        &other
    )));
    assert_eq!(available(f.scheduler.schedule(&scope(), TASK)), None);
    let ahead = slot_after(slot_after(base));
    f.seed_typescript(ahead, Some(base));
    let legacy = f.legacy().unwrap();
    assert!(available(f.scheduler.adopt_legacy(
        &scope(),
        &config,
        &legacy
    )));
    let mut behind = available(f.scheduler.schedule(&scope(), TASK)).unwrap();
    assert_eq!(behind.next_due_at, Some(ahead));
    assert_eq!(behind.last_run_at, Some(base));
    behind.next_due_at = Some(base);
    assert!(!f
        .store
        .publish_task_schedule(PROJECT, TASK, &behind)
        .unwrap());
    assert_eq!(f.legacy().unwrap().next_due_at, Some(ahead));
}
