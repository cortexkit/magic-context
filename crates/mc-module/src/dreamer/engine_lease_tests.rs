//! The dreamer under its role leases: a run asks for its owner's role and
//! acts only while Entorhinal says this computer holds it, journaling the
//! generation it acts under before each batch. The leases come from a
//! stand-in fed Entorhinal's published samples, read on a clock the test
//! sets. Runs take leases only in a build with the `memory-replica`
//! feature; without it, one test checks that they take none.

// The helpers serve the feature's tests; a build without it uses few.
#![cfg_attr(not(feature = "memory-replica"), allow(dead_code, unused_imports))]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use rusqlite::params;
use serde_json::{json, Value};

use super::tests::FOLDER;
use super::*;
use crate::dreamer::lease::Notice;
use crate::dreamer::lease_double::{notices, yielded, Log, SampleLeases, Step};
use crate::dreamer::run::tests::{Client, Ends};
use crate::dreamer::task::{Applied, Batch, Owner, Task, TaskContext};
use crate::summary::fit::Window;

const PROJECT: &str = "pj-lease";
const ROLE: &str = "dreamer.pj-lease";

/// Called with the index of each batch as it is applied, while the next
/// one is still to come.
type Hook = Arc<dyn Fn(usize) + Send + Sync>;

/// A stand-in task of `kind` with `batches` batches. Each accepts any
/// reply and, applied, writes one memory of the run's owner, and for the
/// lift one of the lift's workspace too, then calls `hook`.
struct Leased {
    kind: &'static str,
    batches: usize,
    workspace: Option<&'static str>,
    hook: Hook,
}

struct LeasedBatch {
    index: usize,
    owner: (&'static str, String),
    workspace: Option<&'static str>,
    hook: Hook,
}

impl Task for Leased {
    fn kind(&self) -> &'static str {
        self.kind
    }
    fn once(&self) -> bool {
        self.kind == crate::dreamer::tasks::lift_workspace::KIND
    }
    fn batches(&self, context: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String> {
        let owner = match context.owner {
            Owner::Project { id, .. } => ("project", id.clone()),
            Owner::Workspace { id } => ("workspace", id.clone()),
            Owner::Global => ("global", "self".to_owned()),
        };
        Ok((0..self.batches)
            .map(|index| {
                Box::new(LeasedBatch {
                    index,
                    owner: owner.clone(),
                    workspace: self.workspace,
                    hook: Arc::clone(&self.hook),
                }) as Box<dyn Batch>
            })
            .collect())
    }
}

impl run::TaskInput for LeasedBatch {
    fn system(&self) -> &str {
        "system"
    }
    fn prompt(&self, _: Window, _: u64) -> Option<String> {
        Some(format!("batch {}", self.index))
    }
    fn accepts(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

fn remember(tx: &rusqlite::Transaction<'_>, level: &str, owner: &str, content: &str) {
    tx.execute(
        "INSERT INTO memories (level, owner_id, category, origin_category, content, normalized_hash,
             first_seen_at, created_at, updated_at, last_seen_at, source_type)
         VALUES (?1, ?2, 'swe:naming', 'NAMING', ?3, ?3, 1, 1, 1, 1, 'dreamer')",
        params![level, owner, content],
    )
    .unwrap();
}

impl Batch for LeasedBatch {
    fn apply(
        &self,
        tx: &rusqlite::Transaction<'_>,
        _: &TaskReply,
        _: i64,
    ) -> Result<Applied, String> {
        let (level, owner) = &self.owner;
        remember(tx, level, owner, &format!("{level} batch {}", self.index));
        if let Some(workspace) = self.workspace {
            remember(
                tx,
                "workspace",
                workspace,
                &format!("workspace batch {}", self.index),
            );
        }
        (self.hook)(self.index);
        Ok(Applied {
            proposed: 1,
            applied: 1,
            dropped: Vec::new(),
        })
    }
}

fn store() -> (tempfile::TempDir, Arc<ContextDb>) {
    let dir = tempfile::tempdir().unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    (dir, Arc::new(db))
}

/// A clock the test moves by hand.
fn clock(at: u64) -> (Arc<AtomicU64>, lease::Clock) {
    let now = Arc::new(AtomicU64::new(at));
    let read = Arc::clone(&now);
    (now, Arc::new(move || read.load(Ordering::SeqCst)))
}

fn no_hook() -> Hook {
    Arc::new(|_| {})
}

fn steps(file: &str, role: &str) -> Vec<Step> {
    notices(file, role).into_iter().map(Step::Notice).collect()
}

/// `handback.json`'s notice (gen 9, `handback: true`, seq 3), and the same
/// notice before the request came: seq 2, without handback.
fn handback_notices() -> (Notice, Notice) {
    let handback = notices("handback.json", "dreamer.global").remove(0);
    let mut held = handback.clone();
    held.handback = false;
    held.seq = 2;
    (held, handback)
}

/// An engine running only `task`, leased by `leases` and reading `clock`,
/// with the test project seen.
fn engine(
    db: &ContextDb,
    task: Leased,
    leases: &Arc<SampleLeases>,
    clock: lease::Clock,
) -> Arc<Engine> {
    let leases: Arc<dyn RoleLeases> = leases.clone();
    let engine = Arc::new(
        Engine::new("this", vec![Box::new(task)])
            .with_leases(leases)
            .with_clock(clock),
    );
    let mut profile = crate::memory_profile::prompt_profile(None).unwrap();
    for task in profile.body["tasks"].as_array_mut().unwrap() {
        if task["id"] == "swe:lift-workspace" {
            task["enabled"] = json!(true);
        }
    }
    engine.see_project(
        db,
        PROJECT,
        FOLDER,
        Arc::new(profile),
        &Settings::default(),
        1,
    );
    engine
}

/// A classify run of the test project with `batches` batches, due now.
fn classify(
    db: &ContextDb,
    batches: usize,
    hook: Hook,
    leases: &Arc<SampleLeases>,
    clock: lease::Clock,
) -> Arc<Engine> {
    let task = Leased {
        kind: "classify-memories",
        batches,
        workspace: None,
        hook,
    };
    let engine = engine(db, task, leases, clock);
    db.with_connection(|conn| conn.execute("UPDATE dream_schedules SET next_due_at = 1", []))
        .unwrap();
    engine
}

fn replies(count: usize) -> Arc<Client> {
    Arc::new(Client::new(&["p/a"], &vec![Ends::Reply("ok"); count]))
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

/// The newest run's outcome, error and journaled leases.
fn last_run(db: &ContextDb) -> (Option<String>, Option<String>, Option<Value>) {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT outcome, error, leases_json FROM dream_task_runs ORDER BY id DESC LIMIT 1",
            [],
            |row| {
                let leases: Option<String> = row.get(2)?;
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    leases.map(|text| serde_json::from_str(&text).unwrap()),
                ))
            },
        )
    })
    .unwrap()
}

fn runs(db: &ContextDb) -> i64 {
    db.with_connection(|conn| {
        conn.query_row("SELECT COUNT(*) FROM dream_task_runs", [], |row| row.get(0))
    })
    .unwrap()
}

/// The test project's schedule: status, error and next due time.
fn schedule(db: &ContextDb) -> (Option<String>, Option<String>, Option<i64>) {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT last_status, last_error, next_due_at FROM dream_schedules
              WHERE owner_id = ?1 AND task = 'swe:classify-memories'",
            [PROJECT],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
    })
    .unwrap()
}

/// Each memory the dreamer wrote, with the epoch its outbox row carries.
fn epochs(db: &ContextDb) -> Vec<String> {
    db.with_connection(|conn| {
        conn.prepare(
            "SELECT m.content || ': ' || COALESCE(o.epoch, '-')
               FROM memories m JOIN replica_outbox o ON o.kind = 'memory' AND o.local_id = m.id
              ORDER BY m.id",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
    })
    .unwrap()
}

fn acks(log: &Log, role: &str) -> Vec<u64> {
    log.acks
        .iter()
        .filter(|(acked, _)| acked == role)
        .map(|(_, seq)| *seq)
        .collect()
}

/// On a single computer Entorhinal grants the role at once at gen 1
/// (`sharing-disabled.json`): the run goes as it always did, every batch
/// journaled and published under gen 1, every notice acknowledged, and the
/// watch closed when the run ends.
#[cfg(feature = "memory-replica")]
#[tokio::test]
async fn a_single_computer_runs_the_dreamer_as_before() {
    let (_dir, db) = store();
    let leases = SampleLeases::new();
    leases.default_script(steps("sharing-disabled.json", "dreamer.global"));
    let (_, clock) = clock(120_500);
    let engine = classify(&db, 2, no_hook(), &leases, clock);
    let client = replies(2);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert_eq!(client.sends.lock().unwrap().len(), 2);
    let (outcome, error, journaled) = last_run(&db);
    assert_eq!((outcome.as_deref(), error), (Some("applied"), None));
    assert_eq!(journaled, Some(json!({ROLE: 1})));
    assert_eq!(epochs(&db), ["project batch 0: 1", "project batch 1: 1"]);
    assert_eq!(schedule(&db).0.as_deref(), Some("applied"));
    let log = leases.log();
    assert_eq!(log.opened, [ROLE]);
    assert_eq!(acks(&log, ROLE), [3, 4]);
    assert_eq!(log.closed, [ROLE]);
}

/// A role another computer holds (`not-holding.json`): the run is skipped
/// with the reason, its notice acknowledged all the same, and its schedule
/// moves to the next slot, so the next rounds don't ask again.
#[cfg(feature = "memory-replica")]
#[tokio::test]
async fn a_role_another_computer_holds_skips_the_run_and_is_not_asked_again() {
    let (_dir, db) = store();
    let leases = SampleLeases::new();
    leases.default_script(steps("not-holding.json", "dreamer.pj-fern_01"));
    let (_, clock) = clock(100_500);
    let engine = classify(&db, 1, no_hook(), &leases, clock);
    let client = replies(1);
    let now = now_ms();
    engine.tick(&db, &client, &Settings::default(), now);
    settled(&engine).await;

    let (status, error, next) = schedule(&db);
    assert_eq!(status.as_deref(), Some("skipped"));
    assert_eq!(
        error.as_deref(),
        Some("this computer does not hold dreamer.pj-lease")
    );
    let next = next.unwrap();
    assert!(next > now, "the schedule moved to its next slot");
    assert_eq!(runs(&db), 0, "no run started");
    assert!(client.sends.lock().unwrap().is_empty());
    let log = leases.log();
    assert_eq!(acks(&log, ROLE), [2]);
    assert_eq!(log.closed, [ROLE]);

    // The rounds of the next minute (before the next slot, if that is
    // sooner) find nothing due: no watch is opened again.
    for at in [now + 1, (now + 59_000).min(next - 1)] {
        engine.tick(&db, &client, &Settings::default(), at);
        settled(&engine).await;
    }
    assert_eq!(leases.log().opened, [ROLE]);
    assert_eq!(runs(&db), 0);
}

/// Nothing renews the window (`lapsed.json`, the watch left open), and it
/// closes while the first batch's answer is being written: the check right
/// before the batch commits finds it closed, so the batch is discarded,
/// nothing of it is sent to the other computers, and the run stops.
#[cfg(feature = "memory-replica")]
#[tokio::test]
async fn a_window_that_closes_before_a_batch_commits_discards_the_batch_and_stops_the_run() {
    let (_dir, db) = store();
    let leases = SampleLeases::new();
    leases.default_script(steps("lapsed.json", "dreamer.workspace_02"));
    let (now, clock) = clock(100_500);
    let lapse: Hook = Arc::new(move |_| now.store(140_000, Ordering::SeqCst));
    let engine = classify(&db, 3, lapse, &leases, clock);
    let client = replies(3);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert_eq!(client.sends.lock().unwrap().len(), 1);
    let (outcome, error, journaled) = last_run(&db);
    assert_eq!(outcome.as_deref(), Some("lease_lost"));
    assert_eq!(
        error.as_deref(),
        Some(
            "the dreamer.pj-lease acting window ends at 145000 ms on the monotonic clock, \
             less than 10000 ms after now (140000 ms); the batch's answer was discarded; \
             2 of 3 batches left unsent"
        )
    );
    assert_eq!(journaled, Some(json!({ROLE: 4})));
    assert!(epochs(&db).is_empty(), "the discarded batch wrote nothing");
    assert_eq!(
        db.with_connection(|conn| conn
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0)))
            .unwrap(),
        0
    );
    assert_eq!(schedule(&db).0.as_deref(), Some("failed"));
    // The watch was open until the run itself closed it.
    assert_eq!(leases.log().closed, [ROLE]);
}

/// A run whose first notice comes so late that less than the margin of
/// its window is left starts nothing.
#[cfg(feature = "memory-replica")]
#[tokio::test]
async fn a_late_notice_grants_less_time() {
    let (_dir, db) = store();
    let leases = SampleLeases::new();
    leases.default_script(steps("lapsed.json", "dreamer.workspace_02"));
    // Issued at 100 000 for 45 000, received 36 000 late: 9 000 left.
    let (_, clock) = clock(136_000);
    let engine = classify(&db, 1, no_hook(), &leases, clock);
    let client = replies(1);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert_eq!(schedule(&db).0.as_deref(), Some("skipped"));
    assert!(client.sends.lock().unwrap().is_empty());
}

/// Another computer asks for the role while a batch is in flight
/// (`handback.json`): the batch finishes and is applied, the run yields the
/// role at that safe point, and the hand-over (`yield-transferred.json`)
/// stops it before its next batch, its window not yet passed. It is
/// recorded as handed back, and its watch closes.
#[cfg(feature = "memory-replica")]
#[tokio::test]
async fn a_yield_that_hands_the_role_over_stops_the_run_before_its_next_batch() {
    let (_dir, db) = store();
    let leases = SampleLeases::new();
    let (held, handback) = handback_notices();
    leases.default_script(vec![Step::Notice(held)]);
    leases.answer_yield(ROLE, Ok(yielded("yield-transferred.json")));
    let (_, clock) = clock(100_500);
    let asked = {
        let leases = Arc::clone(&leases);
        Arc::new(move |index| {
            if index == 0 {
                assert!(leases.send(ROLE, Step::Notice(handback.clone())));
            }
        })
    };
    let engine = classify(&db, 3, asked, &leases, clock);
    let client = replies(3);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert_eq!(client.sends.lock().unwrap().len(), 1);
    assert_eq!(epochs(&db), ["project batch 0: 9"]);
    let (outcome, error, _) = last_run(&db);
    assert_eq!(outcome.as_deref(), Some("handed_back"));
    assert_eq!(
        error.as_deref(),
        Some(
            "dreamer.pj-lease was handed over to another computer that asked for it; \
             2 of 3 batches left unsent"
        )
    );
    assert_eq!(schedule(&db).0.as_deref(), Some("handed_back"));
    let log = leases.log();
    assert_eq!(log.yields, [(ROLE.to_owned(), 9)]);
    assert_eq!(acks(&log, ROLE), [2, 3]);
    assert_eq!(log.closed, [ROLE]);
}

/// The same request withdrawn (`yield-withdrawn.json`): the run keeps the
/// role and sends every batch.
#[cfg(feature = "memory-replica")]
#[tokio::test]
async fn a_withdrawn_yield_lets_the_run_go_on() {
    let (_dir, db) = store();
    let leases = SampleLeases::new();
    let (held, handback) = handback_notices();
    leases.default_script(vec![Step::Notice(held)]);
    leases.answer_yield(ROLE, Ok(yielded("yield-withdrawn.json")));
    let (_, clock) = clock(100_500);
    let asked = {
        let leases = Arc::clone(&leases);
        Arc::new(move |index| {
            if index == 0 {
                assert!(leases.send(ROLE, Step::Notice(handback.clone())));
            }
        })
    };
    let engine = classify(&db, 3, asked, &leases, clock);
    let client = replies(3);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert_eq!(client.sends.lock().unwrap().len(), 3);
    assert_eq!(last_run(&db).0.as_deref(), Some("applied"));
    assert_eq!(leases.log().yields, [(ROLE.to_owned(), 9)]);
}

/// A lease older than one the journal has seen for the role is refused
/// before any batch: the computer that holds the newer one acts for it.
#[cfg(feature = "memory-replica")]
#[tokio::test]
async fn an_older_generation_is_refused_by_the_journal() {
    let (_dir, db) = store();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO dream_task_runs (task, kind, level, owner_id, profile, started_at, ended_at,
                                          outcome, leases_json)
             VALUES ('swe:classify-memories', 'classify-memories', 'project', ?1, 'earlier', 1, 2,
                     'applied', ?2)",
            params![PROJECT, json!({ROLE: 5}).to_string()],
        )
    })
    .unwrap();
    let leases = SampleLeases::new();
    // `lapsed.json` grants gen 4.
    leases.default_script(steps("lapsed.json", "dreamer.workspace_02"));
    let (_, clock) = clock(100_500);
    let engine = classify(&db, 2, no_hook(), &leases, clock);
    let client = replies(2);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert!(client.sends.lock().unwrap().is_empty());
    let (outcome, error, journaled) = last_run(&db);
    assert_eq!(outcome.as_deref(), Some("lease_lost"));
    assert_eq!(
        error.as_deref(),
        Some(
            "the journal has seen generation 5 of dreamer.pj-lease, newer than this run's 4; \
             2 of 2 batches left unsent"
        )
    );
    assert_eq!(journaled, None, "nothing is journaled under the older one");
}

/// The lift of the test project into `workspace`, whose `batches` batches
/// each write a project memory and a workspace memory.
fn lift(
    db: &ContextDb,
    workspace: &'static str,
    batches: usize,
    hook: Hook,
    leases: &Arc<SampleLeases>,
    clock: lease::Clock,
) -> (Arc<Engine>, Arc<Client>) {
    let task = Leased {
        kind: crate::dreamer::tasks::lift_workspace::KIND,
        batches,
        workspace: Some(workspace),
        hook,
    };
    let engine = engine(db, task, leases, clock);
    engine.see_workspace(PROJECT, Some(workspace));
    let mut client = Client::new(&["p/a"], &vec![Ends::Reply("ok"); batches]);
    client.entorhinal = Some(crate::workspace_members::tests::answer(
        &[(workspace, "CortexKit")],
        &[
            (PROJECT, "lease", Some(workspace), "local"),
            ("pj-lease-other", "other", Some(workspace), "local"),
        ],
    ));
    (engine, Arc::new(client))
}

/// The lift writes its workspace's memories and its project's, so it holds
/// both roles, the workspace's first (the lock order). Each change carries
/// the generation of its own row's role, and the journal records both.
#[cfg(feature = "memory-replica")]
#[tokio::test]
async fn a_lift_holds_both_roles_and_each_change_carries_its_own_roles_generation() {
    let (_dir, db) = store();
    let workspace = "ws-lease-both";
    let leases = SampleLeases::new();
    let workspace_role = format!("dreamer.{workspace}");
    leases.script(
        &workspace_role,
        steps("lapsed.json", "dreamer.workspace_02"),
    );
    leases.script(ROLE, vec![Step::Notice(handback_notices().0)]);
    let (_, clock) = clock(100_500);
    let (engine, client) = lift(&db, workspace, 1, no_hook(), &leases, clock);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert_eq!(client.sends.lock().unwrap().len(), 1);
    let (outcome, _, journaled) = last_run(&db);
    assert_eq!(outcome.as_deref(), Some("applied"));
    assert_eq!(
        journaled,
        Some(json!({workspace_role.as_str(): 4, ROLE: 9}))
    );
    assert_eq!(epochs(&db), ["project batch 0: 9", "workspace batch 0: 4"]);
    let log = leases.log();
    assert_eq!(log.opened, [workspace_role.as_str(), ROLE]);
    assert_eq!(log.closed.len(), 2);
}

/// Only the workspace's window lapses: the lift needs both roles, so it
/// stops before its next batch.
#[cfg(feature = "memory-replica")]
#[tokio::test]
async fn a_lift_stops_when_only_its_workspace_lease_lapses() {
    let (_dir, db) = store();
    let workspace = "ws-lease-lapse";
    let leases = SampleLeases::new();
    let workspace_role = format!("dreamer.{workspace}");
    // The workspace's window ends at 145 000, the project's at 185 000.
    leases.script(
        &workspace_role,
        steps("lapsed.json", "dreamer.workspace_02"),
    );
    leases.script(ROLE, steps("sharing-disabled.json", "dreamer.global"));
    let (now, clock) = clock(120_500);
    let lapse: Hook = Arc::new(move |_| now.store(140_000, Ordering::SeqCst));
    let (engine, client) = lift(&db, workspace, 3, lapse, &leases, clock);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert_eq!(client.sends.lock().unwrap().len(), 1);
    let (outcome, error, _) = last_run(&db);
    assert_eq!(outcome.as_deref(), Some("lease_lost"));
    assert!(
        error.as_deref().unwrap().starts_with(&format!(
            "the {workspace_role} acting window ends at 145000 ms"
        )),
        "{error:?}"
    );
}

/// Only the project's role is asked back: the lift yields that one, and,
/// once it is handed over, stops, since it needs both. The workspace's
/// role is never offered.
#[cfg(feature = "memory-replica")]
#[tokio::test]
async fn a_lift_yields_the_one_role_asked_back_and_stops() {
    let (_dir, db) = store();
    let workspace = "ws-lease-yield";
    let leases = SampleLeases::new();
    let workspace_role = format!("dreamer.{workspace}");
    leases.script(
        &workspace_role,
        steps("sharing-disabled.json", "dreamer.global"),
    );
    let (mut held, mut handback) = handback_notices();
    // Issued with the clock, so their windows are live.
    held.issued_at_ms = 120_000;
    handback.issued_at_ms = 120_000;
    leases.script(ROLE, vec![Step::Notice(held)]);
    leases.answer_yield(ROLE, Ok(yielded("yield-transferred.json")));
    let (_, clock) = clock(120_500);
    let asked = {
        let leases = Arc::clone(&leases);
        Arc::new(move |index| {
            if index == 0 {
                assert!(leases.send(ROLE, Step::Notice(handback.clone())));
            }
        })
    };
    let (engine, client) = lift(&db, workspace, 3, asked, &leases, clock);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert_eq!(client.sends.lock().unwrap().len(), 1);
    assert_eq!(last_run(&db).0.as_deref(), Some("handed_back"));
    assert_eq!(leases.log().yields, [(ROLE.to_owned(), 9)]);
}

/// Without the `memory-replica` feature the dreamer takes no lease: a run
/// that Entorhinal would refuse (`not-holding.json`) runs as it did before
/// leases existed. It opens no watch, journals no lease, and what it
/// applies carries no epoch.
#[cfg(not(feature = "memory-replica"))]
#[tokio::test]
async fn without_memory_replica_a_run_takes_no_lease() {
    let (_dir, db) = store();
    let leases = SampleLeases::new();
    leases.default_script(steps("not-holding.json", "dreamer.pj-fern_01"));
    let (_, clock) = clock(100_500);
    let engine = classify(&db, 2, no_hook(), &leases, clock);
    let client = replies(2);
    engine.tick(&db, &client, &Settings::default(), now_ms());
    settled(&engine).await;

    assert_eq!(client.sends.lock().unwrap().len(), 2);
    assert_eq!(last_run(&db), (Some("applied".into()), None, None));
    assert_eq!(epochs(&db), ["project batch 0: -", "project batch 1: -"]);
    assert_eq!(schedule(&db).0.as_deref(), Some("applied"));
    assert_eq!(leases.log(), Log::default());
}
