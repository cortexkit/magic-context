//! Witnesses from a review of freeing quiet sessions, on the module and its
//! workers. Each test does the same thing to a session that is freed and to
//! one that is never freed (or states what a never-freed session does), and
//! fails while the two differ: freeing a session must change nothing but the
//! memory it holds.

use super::*;
use cortexkit_role_compaction::ride::RideCause;

fn fail_durable_checkpoint(f: &Fixture) -> rusqlite::Connection {
    let db = rusqlite::Connection::open(f._dir.path().join("sessions.db")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON sessions BEGIN SELECT RAISE(FAIL, 'checkpoint test failure'); END;").unwrap();
    db
}

async fn stamp(f: &Fixture, tag: &str) {
    let reply = f
        .module
        .tool(&f.route, "ctx_reduce", json!({"drop":tag}))
        .await
        .unwrap();
    assert!(reply.contains("1 tag stamped"));
}

#[tokio::test(start_paused = true)]
async fn quiet_worker_retries_its_last_failed_checkpoint_without_a_new_job() {
    let f = Fixture::new("worker", false).await;
    f.drain_quiet_prerequisites().await;
    let db = fail_durable_checkpoint(&f);
    stamp(&f, "2").await;
    // Flush the app snapshot while durable writes still fail. Otherwise its
    // timer could enqueue an app job that saves the queued stamp before the
    // quiet timer fires.
    f.module.flush_app_snapshots().await;
    let worker = f.running_worker().unwrap();
    let store = f.module.inner.store.as_ref().unwrap();
    assert!(
        store.load(f.key()).unwrap().queued.is_empty(),
        "the injected write failed"
    );
    db.execute_batch("DROP TRIGGER fail_checkpoint").unwrap();
    wait_for_worker_exit(&worker, QUIET_AFTER).await;
    assert_eq!(
        store.load(f.key()).unwrap().queued,
        [("b".into(), "p".into())].into()
    );
    assert!(
        f.quiet(),
        "the checkpoint retried and the live worker was released"
    );
}

#[tokio::test(start_paused = true)]
async fn quiet_worker_is_released_after_its_app_checkpoint_retries_the_save() {
    let f = Fixture::new("worker", false).await;
    f.drain_quiet_prerequisites().await;
    // Make the app snapshot fresh without starting any new search work. The
    // next stamp changes a row, but saves the snapshot on its timer instead
    // of inline because a snapshot was just saved.
    stamp(&f, "3").await;
    f.module.flush_app_snapshots().await;
    let db = fail_durable_checkpoint(&f);
    stamp(&f, "2").await;
    f.module.idle_foreground(f.key()).await.unwrap();
    let worker = f.running_worker().unwrap();
    let store = f.module.inner.store.as_ref().unwrap();
    assert_eq!(
        store.load(f.key()).unwrap().queued,
        [("c".into(), "p".into())].into()
    );
    db.execute_batch("DROP TRIGGER fail_checkpoint").unwrap();

    // Only the minute-delayed app job can have retried this early. It also
    // moves the worker's quiet deadline, so the save alone proves no release.
    wait_past_quiet_deadline(Duration::from_secs(60)).await;
    assert_eq!(
        store.load(f.key()).unwrap().queued,
        [("b".into(), "p".into()), ("c".into(), "p".into())].into()
    );
    assert!(!f.quiet(), "the app job restarted the quiet period");
    wait_for_worker_exit(&worker, QUIET_AFTER).await;
    assert!(
        f.quiet(),
        "the checkpoint retried and the live worker was released"
    );
}

#[tokio::test(start_paused = true)]
async fn worker_uses_new_window_for_the_first_notice_or_ride() {
    for via_notice in [true, false] {
        let f = Fixture::configured(
            "worker",
            true,
            Some(r#"{"execute_threshold_tokens":{"default":50000},"protected_tokens":4000}"#),
        )
        .await;
        let mut newest = text(5, "long tail");
        newest.parts[0].body = PartBody::Text {
            text: "x".repeat(24_000).into(),
        };
        f.notice(1, Some(newest), Some(20_000)).await;
        assert!(f
            .module
            .tool(&f.route, "ctx_reduce", json!({"drop":"2"}))
            .await
            .unwrap()
            .contains("1 tag stamped"));
        let mut grown = f.conditions.clone();
        grown.context_window = 200_000;
        grown.statement_seq = Some(4);
        grown.last_prompt_tokens = Some(60_000);
        let output = if via_notice {
            let mut notice = NoticeRequest::new(2, grown);
            notice.newest = f.client().entries.lock().unwrap().last().map(cursor);
            f.module.notice(f.key(), notice).unwrap();
            f.module.idle_foreground(f.key()).await.unwrap();
            f.client().offered.lock().unwrap().last().cloned()
        } else {
            let ride = RideRequest::new(vec![RideCause::CacheExpired], 1_500, grown);
            match f.module.ride(f.key(), ride).await.unwrap() {
                RideAnswer::View { view, .. } => Some(view),
                _ => None,
            }
        };
        assert!(output.is_some(), "the 50k absolute threshold applies to the first pass with the new window (notice: {via_notice})");
    }
}

/// The Setup the fixture sent, sent again under the same statement epoch
/// with the stamp `seq`: a runner that sets its sessions up again, as after
/// it restarted.
fn setup_again(f: &Fixture, preset: &str, seq: u64) -> SetupRequest {
    let mut setup = SetupRequest::new(
        preset,
        ModelRef::new("test", "model"),
        100_000,
        1000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        vec![],
        1,
    );
    setup.newest = f.client().entries.lock().unwrap().last().map(cursor);
    setup.statement_epoch = Some("epoch".into());
    setup.statement_seq = Some(seq);
    setup
}

/// An `over_limit` ride is the runner's last chance before it fails the run:
/// the provider refused the request for length, and the runner waits only
/// the ride's deadline for a smaller view. A session never freed answers at
/// once. A freed session first reads its transcript again, and the ride gets
/// nothing when that read outlasts the deadline. The two-second read stands
/// for the pages of a long transcript; the deadline is the 1.5 s the
/// compaction contract's ride fixtures use. A second freed session, whose
/// read is instant, answers with a view: only the read's time differs.
#[tokio::test(start_paused = true)]
async fn quiet_review_an_over_limit_ride_after_a_free_gets_the_view_a_kept_session_gets() {
    let kept = Fixture::new("worker", true).await;
    let fast = Fixture::new("worker", false).await;
    let freed = Fixture::new("worker", false).await;
    let all = [&kept, &fast, &freed];
    for f in all {
        f.drop_tag(2, 1, 70_000).await;
        // A drop that waits for the next rebuild.
        f.module
            .tool(&f.route, "ctx_reduce", json!({"drop": "3"}))
            .await
            .unwrap();
    }
    kept.wait_quiet_time().await;
    for f in [&fast, &freed] {
        f.wait_for_quiet().await;
    }
    assert!(!kept.quiet(), "a session with a run in flight was freed");
    assert!(fast.quiet() && freed.quiet(), "the sessions went quiet");

    // From here the clock is real, so the ride's deadline runs while the
    // freed session reads its transcript.
    tokio::time::resume();
    *freed.client().read_delay.lock().unwrap() = Duration::from_secs(2);
    let mut answers = Vec::new();
    for f in all {
        let mut conditions = f.conditions.clone();
        conditions.statement_seq = Some(10);
        conditions.last_prompt_tokens = Some(10_000);
        let mut ride = RideRequest::new(vec![RideCause::OverLimit], 1_500, conditions);
        ride.request_tokens = Some(120_000);
        ride.applied_view = f
            .client()
            .applied
            .lock()
            .unwrap()
            .as_ref()
            .map(View::applied);
        let answer = f.module.ride(f.key(), ride).await.unwrap();
        answers.push(matches!(answer, RideAnswer::View { .. }));
    }
    assert!(
        answers[0],
        "a session never freed answers an over_limit ride with a smaller view"
    );
    assert!(
        answers[1],
        "a freed session whose read is quick answers too"
    );
    assert_eq!(
        answers[0], answers[2],
        "the freed session's answer to the same ride (true: a view)"
    );
}

/// The minute-long wait after a run-end event is for a worker that has no
/// more work. When the parent writes to the worker again (its next run
/// starts with `pre_user`), the session is in use, and a tool call that runs
/// for more than a minute must not free it in the middle of that run.
#[tokio::test(start_paused = true)]
async fn quiet_review_a_worker_whose_next_run_started_waits_its_whole_quiet_time() {
    let f = Fixture::new("worker", false).await;
    f.wait_for_quiet().await;
    assert!(f.quiet(), "the worker went quiet without a run-end event");

    // The hook uses the state kept when the worker went quiet to answer
    // before resuming. Hold the replica thread so the previous run's end
    // and the next hook both arrive before the worker finishes resuming.
    let resume_replica = f.module.inner.app_read.gate_thread().await;
    f.module.pre_user(f.key(), "next", 0).await;
    assert!(!f.quiet());
    assert_eq!(
        f.client()
            .ends
            .wake(None, &crate::agent_data::source::session_ref(f.key())),
        crate::run_ends::Woke::Waits(1),
    );
    let next = f
        .module
        .pre_user(f.key(), "One more thing: fix the lexer too", 0);
    tokio::pin!(next);
    assert!(futures_util::poll!(&mut next).is_pending());

    resume_replica.send(()).unwrap();
    next.await;
    f.module.idle_foreground(f.key()).await.unwrap();
    wait_past_quiet_deadline(QUIET_AFTER_RUN_END).await;
    assert!(
        !f.quiet(),
        "a worker in its next run was freed a minute after its last job"
    );
}

/// The reader of the runner's run-end events falls back to polling when it
/// can no longer read them (its consumer on the event stream went away),
/// and wakes every wait so that each polls at once. No run ended then, so no
/// worker may take that wake as its run's end.
#[tokio::test(start_paused = true)]
async fn quiet_review_a_run_end_reader_that_stops_ends_no_run() {
    let f = Fixture::new("worker", false).await;
    f.drain_quiet_prerequisites().await;
    // Starts the worker again if the paused clock freed the session while
    // the search index was waited for.
    f.module.pre_user(f.key(), "next", 0).await;
    f.module.idle_foreground(f.key()).await.unwrap();
    assert!(!f.quiet());
    let ends = &f.client().ends;
    ends.reading();
    ends.stopped("the event stream went away");
    wait_past_quiet_deadline(QUIET_AFTER_RUN_END).await;
    assert!(
        !f.quiet(),
        "a worker whose run did not end was freed a minute after its last job"
    );
}

/// A session that only calls ck-mc's tools never had a Setup: it has no
/// transcript, view or saved state, so nothing stops its worker from being
/// freed. Kept for good, every such session holds a worker and its session
/// for as long as the process runs.
#[tokio::test(start_paused = true)]
async fn quiet_review_a_tools_only_session_lets_its_worker_go_when_quiet() {
    let f = Fixture::new("worker", false).await;
    let route = Route {
        session: SessionRef::new("runner", "mock", "tools-only"),
        project: None,
        workdir: None,
        agent_id: None,
    };
    // Refused for a session ck-mc doesn't compact, but served by a worker.
    let _ = f
        .module
        .tool(&route, "ctx_reduce", json!({"drop": "1"}))
        .await;
    let worker = match f.module.inner.workers.lock().unwrap().get(&route.session) {
        Some(Slot::Running(worker)) => worker.clone(),
        _ => panic!("the tool call did not start a worker"),
    };
    f.module.flush_app_snapshots().await;
    wait_for_worker_exit(&worker, QUIET_AFTER).await;
    assert!(
        !f.module
            .inner
            .workers
            .lock()
            .unwrap()
            .contains_key(&route.session),
        "a session that only called tools kept its worker slot"
    );
}

/// A notice whose transcript read failed (the runner went away) leaves the
/// session to read again on its next job, which is what restoring a freed
/// session does anyway. If no job ever comes, as for a session its runner
/// ended, the session must still be freed rather than held for good.
#[tokio::test(start_paused = true)]
async fn quiet_review_a_session_whose_last_read_failed_is_freed_when_quiet() {
    let f = Fixture::new("worker", false).await;
    *f.client().fail_reads.lock().unwrap() = true;
    f.client().entries.lock().unwrap().push(text(5, "e"));
    // The notice leaves the new entry out, so the worker reads it.
    let mut conditions = f.conditions.clone();
    conditions.statement_seq = Some(2);
    let mut notice = NoticeRequest::new(1, conditions);
    notice.newest = f.client().entries.lock().unwrap().last().map(cursor);
    assert_eq!(f.module.notice(f.key(), notice), Ok(NoticeAnswer::Received));
    f.module.idle_foreground(f.key()).await.unwrap();
    f.wait_for_quiet().await;
    assert!(
        f.quiet(),
        "a session whose last read failed stays in memory"
    );
}

/// A runner that sets its sessions up again (it restarted) makes each read
/// its transcript from the cut. A freed session reads it once to restore
/// itself and again for the Setup: twice the reads, and twice the wait for
/// the first ride after the Setup.
#[tokio::test(start_paused = true)]
async fn quiet_review_setup_after_a_free_reads_the_transcript_as_often_as_a_kept_session() {
    let kept = Fixture::new("worker", true).await;
    let freed = Fixture::new("worker", false).await;
    kept.wait_quiet_time().await;
    freed.wait_for_quiet().await;
    assert!(!kept.quiet(), "a session with a run in flight was freed");
    assert!(freed.quiet(), "the session went quiet");
    let mut reads = Vec::new();
    for f in [&kept, &freed] {
        let before = *f.client().reads.lock().unwrap();
        f.module
            .setup(f.route.clone(), setup_again(f, "worker", 2))
            .unwrap();
        f.module.idle_foreground(f.key()).await.unwrap();
        reads.push(*f.client().reads.lock().unwrap() - before);
    }
    assert_eq!(
        reads[0], reads[1],
        "transcript reads a Setup makes, never freed and freed"
    );
}
