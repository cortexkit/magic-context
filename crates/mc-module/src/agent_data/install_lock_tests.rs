//! The write transactions of a move's install on a large session, measured
//! with the `context-db-timing` samples of the offline mover's write loop,
//! which the install shares.
//!
//! Two bounds are checked. The time bound holds each write transaction to
//! the budget the mover's own lock tests hold its transactions to; a slow
//! or loaded host can break it, so the output prints the load average
//! beside the per-phase maxima. The size bound does not depend on the host:
//! the install's plan is cut into units of at most the mover's batch size
//! of one-row statements, exactly as many units as its rows need, and its
//! write transactions number between its phases and its units. How many
//! units one transaction commits is sized by measured time, as in the
//! mover, so rows per transaction are printed, not bounded.
//!
//! Run on Linux:
//! cargo test --locked --release -p mc-module --features context-db-timing --lib \
//!   install_lock_tests -- --ignored --nocapture

use super::crash_tests::stopped_at;
use super::*;
use crate::agent_data::crash::{Mode, Plan};
use crate::agent_data::install;
use crate::context_db::timing::Transaction;
use std::collections::BTreeMap;
use std::time::Duration;

const SUMMARIES: i64 = 2_000;
const NOTES: i64 = 400;

/// The offline mover's batch size: the most one-row statements a unit of
/// its plan holds (`BATCH_WRITES` in `move_batches.rs`).
const BATCH: usize = 32;

/// The longest the offline mover's tests let one of its write transactions
/// hold `context.db`'s write lock (`every_move_write_transaction_stays_within_100ms`
/// in `move_in`, and the write budget of the `write_lock_budget` scenario).
/// The mover's write loop stops adding units to a transaction at its write
/// window and aims at about 20 ms including the commit, so a transaction
/// can pass the window itself; the budget is the bound its tests hold.
const BUDGET: Duration = Duration::from_millis(100);

/// A session the size of a long-lived one: 2,000 summaries with their full
/// texts and 400 session notes, besides `seed`'s rows.
fn grow(conn: &mut Connection, session: &str) {
    let content = format!(
        "The parser keeps its diagnostic contract. {}",
        "We validated the versioned input before changing any field. ".repeat(16)
    );
    let tx = conn.transaction().unwrap();
    for sequence in 3..=SUMMARIES + 2 {
        tx.execute(
            "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id,
                title, content, p1, p2, p3, p4, importance, created_at, harness)
             VALUES (?1, ?2, ?3, ?4, 'm-a', 'm-b', ?5, ?6, ?6, ?6, ?6, ?6, 60, 100, ?7)",
            params![session, sequence, sequence * 10, sequence * 10 + 9, format!("summary {sequence}"), content, HARNESS],
        )
        .unwrap();
    }
    for note in 1..=NOTES {
        tx.execute(
            "INSERT INTO notes(type, status, content, session_id, project_path, created_at, updated_at, harness, anchor_ordinal)
             VALUES ('session', 'active', ?1, ?2, ?3, 1, 1, ?4, ?5)",
            params![format!("Review parser diagnostic {note} before release."), session, PROJECT, HARNESS, note],
        )
        .unwrap();
    }
    tx.commit().unwrap();
}

/// Two machines, the first holding the large session.
fn large_pair() -> (Machine, Machine) {
    let (a, b) = machines(&["s1"]);
    seed(&a.conn(), "s1", PROJECT);
    grow(&mut a.conn(), "s1");
    (a, b)
}

/// The rows of each moved table the session holds on `machine`, by the
/// install's phase that writes (`insert`) or deletes (`delete`) them.
fn phases(machine: &Machine, verb: &str) -> BTreeMap<String, usize> {
    let rows = snapshot::read_rows(&machine.conn(), HARNESS, "s1").unwrap();
    let embeddings = count(
        &machine.conn(),
        "SELECT COUNT(*) FROM compartment_chunk_embeddings WHERE session_id = 's1'",
    );
    assert_eq!(embeddings, 0, "the plan would delete these rows too");
    moved::MOVED
        .iter()
        .zip(&rows.tables)
        .filter(|(_, rows)| !rows.is_empty())
        .map(|(table, rows)| (format!("agent_data/{verb}/{}", table.name), rows.len()))
        .collect()
}

/// The units a plan of these phases needs at the mover's batch size.
fn units(phases: &BTreeMap<String, usize>) -> usize {
    phases.values().map(|rows| rows.div_ceil(BATCH)).sum()
}

/// The plan `cut`'s install staged on `machine`, before any unit of it was
/// applied: each unit's phase and statements, in order.
fn staged_units(machine: &Machine) -> Vec<(String, Vec<String>)> {
    let conn = machine.conn();
    let mut statement = conn
        .prepare(
            "SELECT value FROM schema_migrations_meta
             WHERE key LIKE 'mode3_batch:agent_data_install:%' ORDER BY key",
        )
        .unwrap();
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|unit| {
            let unit: Value = serde_json::from_str(&unit.unwrap()).unwrap();
            (
                unit["phase"].as_str().unwrap().to_owned(),
                unit["writes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|write| write["sql"].as_str().unwrap().to_owned())
                    .collect(),
            )
        })
        .collect()
}

/// The size bound, on a move back whose install deletes the hidden copy
/// and inserts the session again: the install, stopped once its whole plan
/// is staged and before any unit is applied, holds exactly the units its
/// rows need at the mover's batch size, each of at most that many
/// statements, each of which writes one row.
async fn check_plan_units() {
    let (a, b) = large_pair();
    move_session(&a, &b, CUT, "machine-b").await;
    b.send_out(BACK, &["s1"]).await;
    a.op("import", BACK, &["s1"]).await.unwrap();
    b.release(BACK, &["s1"], "machine-a").await;
    let mut expected = phases(&a, "delete");
    expected.extend(phases(&b, "insert"));
    let plan = Plan::at("commit stage/ready", 0, Mode::Crash);
    assert!(stopped_at(&plan, a.op("activate", BACK, &["s1"]))
        .await
        .is_none());
    let staged = staged_units(&a);
    assert_eq!(staged.len(), units(&expected), "{expected:?}");
    let mut found = BTreeMap::<String, usize>::new();
    for (phase, writes) in &staged {
        assert!(
            !writes.is_empty() && writes.len() <= BATCH,
            "{phase}: {}",
            writes.len()
        );
        for sql in writes {
            let one_row = (sql.starts_with("INSERT INTO ")
                && sql.matches(") VALUES (").count() == 1)
                || (sql.starts_with("DELETE FROM ") && sql.ends_with(" LIMIT 1)"));
            assert!(one_row, "{phase}: {sql}");
        }
        *found.entry(phase.clone()).or_default() += writes.len();
    }
    assert_eq!(found, expected);
}

/// The host's load average, to tell a slow host from a long transaction.
fn load_average() -> String {
    std::fs::read_to_string("/proc/loadavg")
        .map(|load| load.trim().to_owned())
        .unwrap_or_else(|_| "unavailable".to_owned())
}

/// Check one install's transactions against the size and time bounds, and
/// print them per phase. Returns the longest.
fn report(
    direction: &str,
    transactions: &[Transaction],
    phases: &BTreeMap<String, usize>,
) -> Duration {
    let applied: Vec<&Transaction> = transactions
        .iter()
        .filter(|transaction| transaction.phase.starts_with("agent_data/"))
        .collect();
    assert!(
        phases.len() <= applied.len() && applied.len() <= units(phases),
        "{direction}: {} transactions applied {} units of {} phases",
        applied.len(),
        units(phases),
        phases.len()
    );
    let mut per_phase = BTreeMap::<&str, (usize, u64, Duration)>::new();
    for transaction in transactions {
        let entry = per_phase.entry(&transaction.phase).or_default();
        entry.0 += 1;
        entry.1 = entry.1.max(transaction.rows);
        entry.2 = entry.2.max(transaction.sample.elapsed);
    }
    println!("{direction}: phase | transactions | most rows | longest ms");
    for (phase, (count, rows, longest)) in &per_phase {
        println!(
            "{direction}: {phase} | {count} | {rows} | {:.3}",
            longest.as_secs_f64() * 1_000.0
        );
    }
    println!("{direction}: load average {}", load_average());
    transactions
        .iter()
        .map(|transaction| transaction.sample.elapsed)
        .max()
        .unwrap_or_default()
}

/// A move to the second machine installs the session's 2,000 summaries;
/// the move back then deletes the hidden copy on the first and installs
/// them again. Both installs keep the size bound, and every write
/// transaction of both stays within the budget of the mover's own.
#[tokio::test]
#[ignore = "release-mode lock measurement of a 2,000-summary install; command in the module doc"]
async fn every_install_write_on_a_two_thousand_summary_session_stays_within_the_movers_budget() {
    check_plan_units().await;

    let (a, b) = large_pair();
    let there_phases = phases(&a, "insert");
    let transactions = crate::context_db::timing::transactions();
    move_session(&a, &b, CUT, "machine-b").await;
    assert_eq!(b.fingerprint("s1"), a.fingerprint("s1"));
    let there = transactions.take();
    let mut back_phases = phases(&a, "delete");
    back_phases.extend(phases(&b, "insert"));
    move_session(&b, &a, BACK, "machine-a").await;
    assert_eq!(a.fingerprint("s1"), b.fingerprint("s1"));
    let back = transactions.take();
    for (machine, cut, phases) in [(&b, CUT, &there_phases), (&a, BACK, &back_phases)] {
        let record =
            crate::move_batches::record(&machine.conn(), &install::key(cut, HARNESS, "s1"))
                .unwrap()
                .unwrap();
        assert_eq!(record["batches"], units(phases), "{cut}");
    }

    let longest = report("there", &there, &there_phases).max(report("back", &back, &back_phases));
    println!(
        "longest install write transaction {:.3} ms; the mover's write window is {} ms and its budget per write transaction {} ms",
        longest.as_secs_f64() * 1_000.0,
        crate::move_batches::WRITE_WINDOW.as_millis(),
        BUDGET.as_millis()
    );
    assert!(
        longest <= BUDGET,
        "an install write transaction held the lock for {longest:?}, beyond the mover's {BUDGET:?} budget; load average {}",
        load_average()
    );
}
