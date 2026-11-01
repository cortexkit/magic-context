//! Adversarial gate over the claim lane (A1, migration 57) and the single-store
//! marker (B0, migration 58) as one merged chain.
//!
//! These are the sequences that only the store can answer: what the migration
//! chain does when its two newest members meet, and what the claim lane does
//! when several callers reach for one run at once.

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const HISTORIAN_QUEUE_TABLE: &str = "mc_historian_pending_run";
const CLAIM_LANE_MIGRATION_VERSION: u32 = 57;
/// The project every run in this file is queued under. The claim lane is scoped to
/// the caller's project, so every call has to present it.
const GATE_PROJECT: &str = "git:gate";

fn store_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("store.db")
}

/// Register the scope functions a connection replaying the historical chain needs,
/// exactly as a binary of that era provided them.
fn register_era_scope_functions(store: &SqliteStore) {
    store
        .with_conn(|conn| {
            for name in [
                "mc_note_caller_project",
                "mc_facade_authority_domain",
                "mc_facade_authority_route",
            ] {
                conn.create_scalar_function(name, 0, FunctionFlags::SQLITE_UTF8, |_context| {
                    Ok(String::new())
                })?;
            }
            Ok(())
        })
        .unwrap();
}

fn table_exists(store: &SqliteStore, table: &str) -> bool {
    store
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get::<_, i64>(0),
            )
        })
        .unwrap()
        > 0
}

/// The chain a build of the marker's own era carried: everything up to the marker
/// migration, minus one version it had not learned yet.
fn chain_up_to_without(ceiling: u32, version: u32) -> Vec<Migration> {
    MIGRATIONS
        .iter()
        .copied()
        .filter(|migration| migration.version <= ceiling && migration.version != version)
        .collect()
}

fn chain_up_to(version: u32) -> Vec<Migration> {
    MIGRATIONS
        .iter()
        .copied()
        .filter(|migration| migration.version <= version)
        .collect()
}

/// The ordering constraint B0 names in prose, executed: if a store applies 58
/// while 57 is not yet part of the chain, 57 never runs afterwards and the claim
/// lane has no table to write to.
///
/// The migrator skips every version at or below the recorded MAXIMUM, so the gap
/// is permanent rather than filled on the next boot. This is why the two have to
/// reach any store in numeric order, which on this merged tree they do.
///
/// The consequence is now louder than it was when 58 was the newest migration. A
/// later migration extends the very table 57 creates, so the skew no longer opens
/// quietly and fails at the first queued run: the store refuses to open at all,
/// and it names the missing table while doing so. Either way 57 is gone for good;
/// the point of the test is that the gap is permanent, not which call reports it.
#[test]
fn gate_a_store_that_applied_58_first_never_gets_57() {
    let dir = tempfile::tempdir().unwrap();
    let descriptor = descriptor(dir.path());

    // A build of that era: the marker migration but not the claim-queue one, and
    // nothing newer than the marker, because nothing newer existed yet.
    let marker_only = open_sqlite(&descriptor).unwrap();
    register_era_scope_functions(&marker_only);
    let skewed = marker_only
        .migrate(
            NS,
            &chain_up_to_without(
                SINGLE_STORE_MARKER_MIGRATION_VERSION,
                CLAIM_LANE_MIGRATION_VERSION,
            ),
        )
        .unwrap();
    assert_eq!(skewed.recorded, SINGLE_STORE_MARKER_MIGRATION_VERSION);
    assert!(
        !table_exists(&marker_only, HISTORIAN_QUEUE_TABLE),
        "this build never carried the claim queue"
    );
    drop(marker_only);

    // The current chain arrives later. 57 is at or below the recorded maximum, so
    // it is skipped for good, and the migration that extends its table has nothing
    // to extend.
    let Err(error) = McStore::open_for_test(&descriptor) else {
        panic!("a store missing the table migration 60 extends must not open");
    };
    let rendered = error.to_string();
    assert!(
        rendered.contains(HISTORIAN_QUEUE_TABLE),
        "the refusal has to name the missing table: {rendered}"
    );

    // And the skip really is permanent: a chain that stops at the marker opens the
    // store fine and still has no queue table to write a run into.
    let stalled = open_sqlite(&descriptor).unwrap();
    register_era_scope_functions(&stalled);
    let outcome = stalled
        .migrate(NS, &chain_up_to(SINGLE_STORE_MARKER_MIGRATION_VERSION))
        .unwrap();
    // The refused open above still applied every migration below the one that
    // failed, so the recorded maximum can sit past the marker (59 applies before 60
    // fails). What matters is only that it is at or past the marker.
    assert!(
        outcome.recorded >= SINGLE_STORE_MARKER_MIGRATION_VERSION,
        "recorded {} is below the marker",
        outcome.recorded
    );
    assert!(
        !table_exists(&stalled, HISTORIAN_QUEUE_TABLE),
        "57 is permanently skipped once 58 is recorded"
    );
}

/// A report produced under a superseded attempt is refused by every mc-store
/// site that CASes on the publish predicate, not just by the publish itself.
///
/// The control in the same test is the current attempt: the identical call with
/// the attempt the session actually holds is accepted, which makes the refusals
/// statements about the attempt rather than about the fixture.
#[test]
fn gate_a_prior_attempts_report_is_refused_at_every_predicate_site() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();

    let mut meta = publishing_meta();
    meta.historian.producer_attempt = 2;
    store
        .commit("ses", None, &CoreState::default(), &meta)
        .unwrap();

    let mut stale = publish_predicate();
    stale.producer_attempt = 1;
    let mut current = publish_predicate();
    current.producer_attempt = 2;

    // 1. The failure counter.
    assert_eq!(
        store
            .record_historian_publish_failure_if_matching("ses", &stale)
            .unwrap(),
        None,
        "a prior attempt cannot even move the publish-health counter"
    );
    assert!(store
        .record_historian_publish_failure_if_matching("ses", &current)
        .unwrap()
        .is_some());

    // 2. The abandon path.
    assert_eq!(
        store
            .abandon_historian_run_if_matching_with_publish_failure(
                "ses",
                &stale,
                Some(123),
                Some("stale"),
                false,
            )
            .unwrap(),
        None,
        "a prior attempt cannot release a run it no longer owns"
    );
    assert_eq!(
        store.historian_state("ses").unwrap().state,
        HistorianPhase::Publishing,
        "the phase is untouched by the refused call"
    );

    // 3. The publish CAS.
    let loaded = store.load("ses").unwrap();
    let error = store
        .publish_historian_chunk(HistorianPublishRequest {
            rust_background_enabled: false,
            lifecycle_publication_id: None,
            harness: None,
            session_id: "ses",
            expected_row_version: loaded.row_version,
            expected_revert_epoch: 0,
            predicate: &stale,
            project_path: "git:proj",
            compartments: &[publish_compartment()],
            facts: &[],
            promote_facts: true,
            events: &[],
            primer_candidates: &[],
            user_memory_candidates: &[],
            publication_floor_ordinal: 21,
            chunk_transcript: None,
            raw_chunk_messages: None,
        })
        .unwrap_err();
    assert!(
        matches!(error, HistorianPublishError::StateMismatch { .. }),
        "a prior attempt's publish is refused before any row is appended: {error:?}"
    );
    assert_eq!(
        store.load_compartments("ses").unwrap().len(),
        0,
        "nothing was appended"
    );

    // The control: the same publish under the attempt the session holds lands.
    let loaded = store.load("ses").unwrap();
    let published = store
        .publish_historian_chunk(HistorianPublishRequest {
            rust_background_enabled: false,
            lifecycle_publication_id: None,
            harness: None,
            session_id: "ses",
            expected_row_version: loaded.row_version,
            expected_revert_epoch: 0,
            predicate: &current,
            project_path: "git:proj",
            compartments: &[publish_compartment()],
            facts: &[],
            promote_facts: true,
            events: &[],
            primer_candidates: &[],
            user_memory_candidates: &[],
            publication_floor_ordinal: 21,
            chunk_transcript: None,
            raw_chunk_messages: None,
        })
        .unwrap();
    assert!(published.row_version > 0);
    assert_eq!(store.load_compartments("ses").unwrap().len(), 1);
}

fn gate_queue_run(
    store: &McStore,
    run_id: &str,
    session_id: &str,
    now_ms: i64,
    await_budget_ms: i64,
) {
    let loaded = store.load(session_id).unwrap();
    let mut meta = ModuleMeta::default();
    meta.historian.state = HistorianPhase::Firing;
    meta.historian.firing_seq = 1;
    meta.historian.chunk_fingerprint = "fp".to_string();
    store
        .commit(session_id, loaded.row_version, &CoreState::default(), &meta)
        .unwrap();
    store
        .publish_pending_historian_run(&NewHistorianPendingRun {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            project_path: GATE_PROJECT.to_string(),
            firing_seq: 1,
            chunk_fingerprint: "fp".to_string(),
            system_prompt: "sys".to_string(),
            user_prompt: "user".to_string(),
            model_chain: vec!["test/model".to_string()],
            await_budget_ms,
            historian_timeout_ms: None,
            now_ms,
        })
        .unwrap();
}

/// Eight claimants reaching for one run at the same instant: exactly one token
/// is minted, and after the lease lapses exactly one replacement is admitted
/// under the next attempt. No interleaving produces two live claims.
#[test]
fn gate_a_crowd_of_claimants_on_one_run_mints_exactly_one_token_per_generation() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(McStore::open_for_test(&descriptor(dir.path())).unwrap());
    let queued_at_ms = 1_000_000;
    gate_queue_run(&store, "run-crowd", "ses", queued_at_ms, 660_000);

    for (generation, now_ms) in [
        (1u32, queued_at_ms + 1),
        // Past the lease ceiling but inside the run's own deadline.
        (2u32, queued_at_ms + HISTORIAN_LEASE_CEILING_MS + 1),
    ] {
        let winners = Arc::new(AtomicUsize::new(0));
        let already_claimed = Arc::new(AtomicUsize::new(0));
        let tokens = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        std::thread::scope(|scope| {
            for claimant in 0..8u32 {
                let store = Arc::clone(&store);
                let winners = Arc::clone(&winners);
                let already_claimed = Arc::clone(&already_claimed);
                let tokens = Arc::clone(&tokens);
                scope.spawn(move || {
                    match store
                        .claim_historian_run(
                            GATE_PROJECT,
                            "run-crowd",
                            &format!("install-{claimant}"),
                            now_ms,
                        )
                        .unwrap()
                    {
                        HistorianClaimOutcome::Claimed(claim) => {
                            assert_eq!(claim.attempt, generation);
                            winners.fetch_add(1, Ordering::SeqCst);
                            tokens.lock().unwrap().push(claim.token);
                        }
                        HistorianClaimOutcome::Refused(HistorianClaimRefusal::AlreadyClaimed) => {
                            already_claimed.fetch_add(1, Ordering::SeqCst);
                        }
                        other => panic!("unexpected claim outcome: {other:?}"),
                    }
                });
            }
        });
        assert_eq!(
            winners.load(Ordering::SeqCst),
            1,
            "generation {generation}: exactly one claimant may hold the run"
        );
        assert_eq!(already_claimed.load(Ordering::SeqCst), 7);

        let state = store.historian_state("ses").unwrap();
        assert_eq!(state.state, HistorianPhase::AwaitingProducer);
        assert_eq!(state.producer_attempt, generation);
        assert_eq!(
            state.coordinator_token.as_deref(),
            Some(tokens.lock().unwrap()[0].as_str()),
            "generation {generation}: the session names the winner's token"
        );
        assert_eq!(
            state.producer_run_id.as_deref(),
            Some("run-crowd"),
            "the replacement continues the same run"
        );
        assert_eq!(state.chunk_fingerprint, "fp", "and keeps its chunk");
    }
}

/// A `pending` listing that runs while claims and expiries are landing never
/// sees the queue row and the session state disagree.
///
/// The two are written in one transaction, so the check is done from a SECOND
/// connection reading both rows inside one read transaction: a reader that could
/// see one without the other would catch a half-applied claim.
#[test]
fn gate_a_reader_never_catches_a_claim_half_applied() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(McStore::open_for_test(&descriptor(dir.path())).unwrap());
    let queued_at_ms = 1_000_000;
    // The run's own deadline has to outlive thousands of lease cycles, or the
    // writer runs out of claimable time long before the reader has sampled both
    // halves and the test starts passing for the wrong reason.
    let budget_ms = HISTORIAN_LEASE_CEILING_MS * 10_000;
    gate_queue_run(&store, "run-raced", "ses", queued_at_ms, budget_ms);

    let path = store_path(dir.path());
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let claimed_seen = Arc::new(AtomicUsize::new(0));
    let pending_seen = Arc::new(AtomicUsize::new(0));

    std::thread::scope(|scope| {
        let writer_store = Arc::clone(&store);
        let writer_stop = Arc::clone(&stop);
        let writer_claimed = Arc::clone(&claimed_seen);
        let writer_pending = Arc::clone(&pending_seen);
        scope.spawn(move || {
            // Cycle the run between claimed and offerable until the reader has
            // caught it in BOTH states. A fixed round count would let a reader
            // starved by a loaded box finish having observed only one of them,
            // which is a test that passes without checking anything.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            let mut round = 0i64;
            while (writer_claimed.load(Ordering::SeqCst) == 0
                || writer_pending.load(Ordering::SeqCst) == 0)
                && std::time::Instant::now() < deadline
            {
                let now_ms = queued_at_ms + round * (HISTORIAN_LEASE_CEILING_MS + 1);
                round += 1;
                let _ = writer_store.claim_historian_run(
                    GATE_PROJECT,
                    "run-raced",
                    "install-a",
                    now_ms,
                );
                // Hold each half briefly so a reader has a real chance to land in it.
                std::thread::sleep(std::time::Duration::from_millis(1));
                let _ =
                    writer_store.expire_historian_claims(now_ms + HISTORIAN_LEASE_CEILING_MS + 1);
                std::thread::sleep(std::time::Duration::from_millis(1));
                let _ = writer_store.list_pending_historian_runs(GATE_PROJECT, None, now_ms);
            }
            writer_stop.store(true, Ordering::SeqCst);
        });

        let reader_stop = Arc::clone(&stop);
        let reader_claimed = Arc::clone(&claimed_seen);
        let reader_pending = Arc::clone(&pending_seen);
        scope.spawn(move || {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.busy_timeout(std::time::Duration::from_secs(10))
                .unwrap();
            while !reader_stop.load(Ordering::SeqCst) {
                let read = conn.unchecked_transaction();
                let Ok(tx) = read else { continue };
                let queue: Option<(String, Option<String>)> = tx
                    .query_row(
                        "SELECT phase, coordinator_token FROM mc_historian_pending_run
                          WHERE run_id = 'run-raced'",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .unwrap();
                let meta_json: Option<String> = tx
                    .query_row(
                        "SELECT meta FROM mc_cache_state WHERE session_id = 'ses'",
                        [],
                        |row| row.get(0),
                    )
                    .optional()
                    .unwrap();
                drop(tx);
                let (Some((phase, queue_token)), Some(meta_json)) = (queue, meta_json) else {
                    continue;
                };
                let meta: ModuleMeta = serde_json::from_str(&meta_json).unwrap();
                match phase.as_str() {
                    "claimed" => {
                        reader_claimed.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(
                            meta.historian.state,
                            HistorianPhase::AwaitingProducer,
                            "a claimed queue row must never be visible beside an unparked session"
                        );
                        assert_eq!(
                            meta.historian.coordinator_token, queue_token,
                            "the queue row and the session must name the same claim"
                        );
                    }
                    "pending" => {
                        reader_pending.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(queue_token, None);
                        assert_eq!(
                            meta.historian.state,
                            HistorianPhase::Reclaiming,
                            "an offerable queue row must never be visible beside a claimed session"
                        );
                        assert_eq!(meta.historian.coordinator_token, None);
                    }
                    other => panic!("unexpected queue phase {other}"),
                }
            }
        });
    });

    // Both halves of the cycle have to have been observed, or the reader never
    // reached the state a half-applied claim would show up in.
    assert!(
        claimed_seen.load(Ordering::SeqCst) > 0,
        "the reader never caught the run under a claim, so it checked nothing"
    );
    assert!(
        pending_seen.load(Ordering::SeqCst) > 0,
        "the reader never caught the run between claims"
    );
}

/// A `pending` poll runs while another connection holds an open write
/// transaction with uncommitted rows in it, and neither waits for the other.
///
/// This is the shape the claim lane lives in: every claimant polls on an
/// interval against the same file the transform commits to. A poll that took the
/// store's exclusive write lock would serialize every one of those polls against
/// real work, for a query that writes nothing. The writer here does what a
/// transform commit does — `BEGIN IMMEDIATE`, write a session row, commit — and
/// the poll has to come back with its answer before the writer commits.
#[test]
fn gate_a_pending_poll_does_not_block_a_concurrent_transform_commit() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
    let queued_at_ms = 1_000;
    gate_queue_run(&store, "run-polled", "ses", queued_at_ms, 660_000);

    // A second connection, exactly as a second process would open it.
    let writer = rusqlite::Connection::open(store_path(dir.path())).unwrap();
    // Shorter than the store's own busy timeout, so a poll that DOES contend for
    // the write lock fails inside this test rather than after it.
    writer
        .busy_timeout(std::time::Duration::from_millis(250))
        .unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    writer
        .execute(
            "UPDATE mc_cache_state SET row_version = row_version + 1 WHERE session_id = 'ses'",
            [],
        )
        .unwrap();

    let started = std::time::Instant::now();
    let polled = store
        .list_pending_historian_runs(GATE_PROJECT, None, queued_at_ms + 1)
        .expect("a poll must not contend for the write lock a transform commit holds");
    let elapsed = started.elapsed();

    assert_eq!(
        polled
            .iter()
            .map(|run| run.run_id.as_str())
            .collect::<Vec<_>>(),
        vec!["run-polled"],
        "the poll answers from the committed snapshot"
    );
    assert!(
        elapsed < std::time::Duration::from_secs(2),
        "the poll waited {elapsed:?}, which means it queued behind the writer"
    );

    // And the write that was in flight the whole time commits normally.
    writer.execute_batch("COMMIT").unwrap();
    let row_version: i64 = writer
        .query_row(
            "SELECT row_version FROM mc_cache_state WHERE session_id = 'ses'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(row_version > 0);
}

/// Migration 59 (publish durations) lands on a store an older build left at 58 with
/// a pass trace already recorded: the trace row keeps its counts, the new columns
/// start empty, and the first publish after the upgrade is measured on that row.
#[test]
fn gate_the_publish_duration_columns_land_on_a_populated_store_at_58() {
    let dir = tempfile::tempdir().unwrap();
    let descriptor = descriptor(dir.path());

    let older = open_sqlite(&descriptor).unwrap();
    register_era_scope_functions(&older);
    let at_58 = older.migrate(NS, &chain_up_to(58)).unwrap();
    assert_eq!(at_58.recorded, 58);
    // The row a build at 58 writes when a pass arrives, in that build's own shape.
    older
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO mc_pass_trace
                     (session_id, last_received_at_ms, last_completed_at_ms, reject_count, receive_count)
                 VALUES ('ses', 1700, 1750, 0, 3)",
                [],
            )
        })
        .unwrap();
    drop(older);

    let migrated = McStore::open_for_test(&descriptor).unwrap();
    assert_eq!(
        migrated.module_store_schema_version().unwrap(),
        crate::LATEST_MIGRATION_VERSION
    );
    let trace = migrated.load_pass_trace("ses").unwrap().unwrap();
    assert_eq!(trace.last_received_at_ms, 1_700);
    assert_eq!(trace.receive_count, 3);
    assert_eq!(
        migrated.load_publish_timing("ses").unwrap(),
        Some(PublishTiming {
            last_publish_duration_us: None,
            max_publish_duration_us: None,
            publish_sample_count: 0,
        }),
        "an upgraded row has no publish sample until a publish is measured"
    );

    migrated.record_publish_duration("ses", 2_500).unwrap();
    assert_eq!(
        migrated.load_publish_timing("ses").unwrap(),
        Some(PublishTiming {
            last_publish_duration_us: Some(2_500),
            max_publish_duration_us: Some(2_500),
            publish_sample_count: 1,
        })
    );
    assert_eq!(
        migrated
            .load_pass_trace("ses")
            .unwrap()
            .unwrap()
            .receive_count,
        3
    );
}
