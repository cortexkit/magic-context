//! Observe executed SQL, not scheduler latency, to defend the mover's lock budget.

use super::*;
use std::collections::BTreeMap;

#[derive(Clone, Copy)]
pub(crate) enum Clock {
    Stop,
    Continue,
}

#[derive(Default)]
struct Transaction {
    phase: String,
    statements: usize,
    staged: usize,
    applied: usize,
    reads: usize,
    clock_checks: usize,
    committed: bool,
}

struct Observation {
    clock: Clock,
    seed: usize,
    probe: Option<Connection>,
    current: Option<Transaction>,
    transactions: Vec<Transaction>,
    units: BTreeMap<String, (String, usize)>,
    errors: Vec<String>,
    released: usize,
}

thread_local! {
    static OBSERVATION: RefCell<Option<Observation>> = const { RefCell::new(None) };
}

pub(crate) struct Guard;

impl Drop for Guard {
    fn drop(&mut self) {
        OBSERVATION.with_borrow_mut(|state| *state = None);
    }
}

pub(crate) fn fixed_clock(clock: Clock, seed: usize) -> Guard {
    OBSERVATION.with_borrow_mut(|state| {
        assert!(state.is_none());
        *state = Some(Observation {
            clock,
            seed,
            probe: None,
            current: None,
            transactions: Vec::new(),
            units: BTreeMap::new(),
            errors: Vec::new(),
            released: 0,
        });
    });
    Guard
}

pub(crate) fn write_window_open(started: Instant, window: Duration) -> bool {
    OBSERVATION.with_borrow_mut(|state| match state {
        Some(state) => {
            if let Some(tx) = &mut state.current {
                tx.clock_checks += 1;
            }
            matches!(state.clock, Clock::Continue)
        }
        None => started.elapsed() < window,
    })
}

pub(crate) fn grouping_duration(held: Duration) -> Duration {
    OBSERVATION.with_borrow(|state| {
        if state.is_some() {
            Duration::from_nanos(1)
        } else {
            held
        }
    })
}

pub(crate) fn initial_units() -> usize {
    OBSERVATION.with_borrow(|state| state.as_ref().map_or(1, |state| state.seed))
}

pub(super) fn label(phase: &str) {
    OBSERVATION.with_borrow_mut(|state| {
        if let Some(tx) = state.as_mut().and_then(|state| state.current.as_mut()) {
            tx.phase = phase.into();
        }
    });
}

pub(super) fn after_commit(phase: &str) -> Result<(), String> {
    OBSERVATION.with_borrow_mut(|state| {
        let Some(state) = state else { return Ok(()) };
        let Some(probe) = &state.probe else {
            return Ok(());
        };
        let tx = state.current.take().ok_or("missing traced transaction")?;
        if !tx.committed || tx.phase != phase {
            return Err(format!("{phase}: write transaction did not commit"));
        }
        // A zero-timeout writer on another connection must acquire the lock at
        // every boundary. No concurrent scheduling or elapsed-time bound is needed.
        probe
            .execute_batch("BEGIN IMMEDIATE; INSERT INTO move_lock_probe DEFAULT VALUES; COMMIT")
            .map_err(|error| format!("{phase}: write lock was not released: {error}"))?;
        state.released += 1;
        state.transactions.push(tx);
        Ok(())
    })
}

fn observe(db: &ContextDb, path: &std::path::Path, clock: Clock, seed: usize) -> Guard {
    let guard = fixed_clock(clock, seed);
    let probe = Connection::open(path).unwrap();
    probe.busy_timeout(Duration::ZERO).unwrap();
    probe
        .execute_batch("CREATE TABLE move_lock_probe(id INTEGER PRIMARY KEY)")
        .unwrap();
    OBSERVATION.with_borrow_mut(|state| state.as_mut().unwrap().probe = Some(probe));
    db.with_connection(|conn| conn.trace(Some(trace)));
    guard
}

// SQLite expands bound strings in its trace. Decode SQL quoting before reading
// the staged JSON so an apostrophe in a fixture cannot change the accounting.
fn literals(sql: &str) -> Vec<String> {
    let mut chars = sql.chars().peekable();
    let mut values = Vec::new();
    while let Some(c) = chars.next() {
        if c != '\'' {
            continue;
        }
        let mut value = String::new();
        while let Some(c) = chars.next() {
            if c == '\'' {
                if chars.peek() == Some(&'\'') {
                    chars.next();
                } else {
                    break;
                }
            }
            value.push(c);
        }
        values.push(value);
    }
    values
}

fn trace(sql: &str) {
    // FTS shadow-table statements and triggers are SQLite's implementation of
    // a top-level write, not additional plan statements or discovery reads.
    if sql.starts_with("--") {
        return;
    }
    OBSERVATION.with_borrow_mut(|state| {
        let Some(state) = state else { return };
        let normalized = sql.split_whitespace().collect::<Vec<_>>().join(" ");
        // SQLite's own FTS configuration reads are triggered by the primers
        // FTS trigger, not by mover work. Match the complete statements only.
        if [
            "PRAGMA 'main'.data_version",
            "SELECT k, v FROM 'main'.'primers_fts_config'",
        ]
        .contains(&normalized.as_str())
        {
            return;
        }
        if normalized == "BEGIN IMMEDIATE" {
            if state.current.is_some() {
                state.errors.push("nested write transaction".into());
            }
            state.current = Some(Transaction::default());
            return;
        }
        let Some(tx) = &mut state.current else { return };
        if normalized == "COMMIT" {
            tx.committed = true;
            return;
        }
        let values = literals(sql);
        if normalized.starts_with("SELECT ") {
            // The one permitted read guards the saved progress record against
            // another mover. Its primary-key lookup is not discovery or batch loading.
            let allowed_progress_read = values.first().is_some_and(|key| {
                [
                    "mode3_renumber:opencode:moving",
                    "mode3_rekey:moving",
                    "mode3_cap",
                ]
                .contains(&key.as_str())
                    && normalized
                        == format!("SELECT value FROM schema_migrations_meta WHERE key='{key}'")
            });
            if !allowed_progress_read {
                state.errors.push(format!(
                    "{}: read inside write transaction: {sql}",
                    tx.phase
                ));
            }
            tx.reads += 1;
            return;
        }
        if !["INSERT ", "UPDATE ", "DELETE "]
            .iter()
            .any(|prefix| normalized.starts_with(prefix))
        {
            state.errors.push(format!(
                "{}: unexpected work inside write transaction: {sql}",
                tx.phase
            ));
            return;
        }
        tx.statements += 1;
        if let Some(key) = values.first().filter(|key| key.starts_with("mode3_batch:")) {
            if normalized.starts_with("INSERT ") {
                let unit: serde_json::Value = serde_json::from_str(&values[1]).unwrap();
                let writes = unit["writes"].as_array().unwrap().len();
                if !(1..=32).contains(&writes) {
                    state.errors.push(format!(
                        "plan unit contains {writes} writes, expected 1..=32"
                    ));
                }
                state.units.insert(
                    key.clone(),
                    (unit["phase"].as_str().unwrap().into(), writes),
                );
                tx.staged += 1;
            } else if normalized.starts_with("DELETE ") {
                if !state.units.contains_key(key) {
                    state.errors.push(format!("unobserved plan unit {key}"));
                }
                tx.applied += 1;
            }
        }
    });
}

fn finish(db: Option<&ContextDb>) -> Observation {
    if let Some(db) = db {
        db.with_connection(|conn| conn.trace(None));
    }
    let observation = OBSERVATION.with_borrow_mut(Option::take).unwrap();
    assert!(observation.errors.is_empty(), "{:?}", observation.errors);
    assert!(observation.current.is_none(), "write transaction left open");
    assert_eq!(observation.released, observation.transactions.len());
    observation
}

#[test]
fn every_move_write_transaction_has_bounded_work_and_releases_the_lock() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    let (db, _) = fixture(&path, 2_000, 20_000);
    let _guard = observe(&db, &path, Clock::Stop, 1);
    move_in(
        db,
        &Store::open(&dir.path().join("mode3.db")).unwrap(),
        &crate::pass::Settings::default().into(),
        &request(2_000),
    )
    .unwrap();
    let observed = finish(None);
    let transactions = &observed.transactions;
    let staged: usize = transactions.iter().map(|tx| tx.staged).sum();
    let applied: usize = transactions.iter().map(|tx| tx.applied).sum();
    assert_eq!(staged, observed.units.len());
    assert_eq!(applied, staged);
    assert!(transactions.iter().map(|tx| tx.clock_checks).sum::<usize>() > 0);
    for tx in transactions {
        match tx.phase.as_str() {
            "stage/batch" => {
                assert_eq!(tx.staged, 1, "clock must be checked between staged units");
                assert_eq!(tx.statements, 1);
                assert_eq!(tx.reads, 0);
            }
            "stage/start" | "stage/ready" | "finish" | "fence" => {
                assert_eq!(tx.statements, if tx.phase == "fence" { 2 } else { 1 });
                assert_eq!(tx.reads, 0);
            }
            _ => {
                assert_eq!(tx.applied, 1, "clock must be checked between applied units");
                assert!(
                    (3..=34).contains(&tx.statements),
                    "{}: {} statements",
                    tx.phase,
                    tx.statements
                );
                assert_eq!(tx.reads, 1, "only the primary-key progress guard may read");
            }
        }
    }
    // Two plans each have start/ready/finish markers; the move writes one fence.
    // With the stop clock, every staged unit and every applied unit commits alone.
    assert_eq!(transactions.len(), 2 * staged + 7);
    for phase in ["rekey/tags", "renumber/message_history_source"] {
        let units: Vec<_> = observed
            .units
            .values()
            .filter(|(p, _)| p == phase)
            .collect();
        assert_eq!(units.iter().map(|(_, writes)| writes).sum::<usize>(), 2_000);
        assert_eq!(units.len(), 2_000_usize.div_ceil(32));
        assert_eq!(
            transactions.iter().filter(|tx| tx.phase == phase).count(),
            2_000_usize.div_ceil(32)
        );
    }
}

#[test]
fn move_in_never_stop_clock_still_commits_at_the_unit_cap() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    let db = ContextDb::create_for_tests(&path).unwrap();
    let _guard = observe(&db, &path, Clock::Continue, 4096);
    db.with_connection(|conn| {
        conn.execute_batch("CREATE TABLE cap_probe(id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO cap_probe VALUES(1,0)").unwrap();
        let plan = crate::move_batches::Plan::default();
        plan.phase("cap");
        for _ in 0..4097 * 32 {
            plan.execute("UPDATE cap_probe SET value=value+1 WHERE rowid=?1", &[&1]).unwrap();
        }
        plan.stage(conn, "mode3_cap", serde_json::json!({})).unwrap();
        assert_eq!(conn.query_row("SELECT value FROM cap_probe", [], |row| row.get::<_, usize>(0)).unwrap(), 4097 * 32);
    });
    let observed = finish(Some(&db));
    assert_eq!(observed.units.len(), 4097);
    for phase in ["stage/batch", "cap"] {
        let transactions: Vec<_> = observed
            .transactions
            .iter()
            .filter(|tx| tx.phase == phase)
            .collect();
        assert_eq!(transactions.len(), 2, "{phase}");
        let units = |tx: &Transaction| {
            if phase == "cap" {
                tx.applied
            } else {
                tx.staged
            }
        };
        assert_eq!(units(transactions[0]), 4096, "{phase}");
        assert_eq!(units(transactions[1]), 1, "{phase}");
        assert_eq!(
            transactions[0].clock_checks, 4095,
            "check the clock between every unit"
        );
    }
}
