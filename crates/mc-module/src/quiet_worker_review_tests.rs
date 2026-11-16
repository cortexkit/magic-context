//! Witnesses from a review of freeing quiet sessions, on the module and its
//! workers. Each test does the same thing to a session that is freed and to
//! one that is never freed (or states what a never-freed session does), and
//! fails while the two differ: freeing a session must change nothing but the
//! memory it holds.

use super::*;
use cortexkit_role_compaction::ride::RideCause;

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
    for f in all {
        f.wait_quiet_time().await;
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

/// A person's message to a head that has no summary yet: the freed session
/// can't answer `pre_user` from what it kept, so the hook waits for the
/// transcript read, and past ck-mc's own budget ([`PRE_USER_BUDGET`]) the
/// message is stored without the time marker a session never freed adds. A
/// second freed session, whose read is instant, adds the marker.
#[tokio::test(start_paused = true)]
async fn quiet_review_pre_user_after_a_free_gets_the_time_marker_a_kept_session_gets() {
    let kept = Fixture::new("head", true).await;
    let fast = Fixture::new("head", false).await;
    let freed = Fixture::new("head", false).await;
    let all = [&kept, &fast, &freed];
    for f in all {
        f.wait_quiet_time().await;
    }
    assert!(!kept.quiet(), "a session with a run in flight was freed");
    assert!(fast.quiet() && freed.quiet(), "the sessions went quiet");

    tokio::time::resume();
    *freed.client().read_delay.lock().unwrap() = Duration::from_secs(2);
    let now = 30 * 60_000;
    let mut answers = Vec::new();
    for f in all {
        answers.push(
            f.module
                .pre_user(f.key(), "Carry on with the parser fix", now)
                .await,
        );
    }
    assert!(
        answers[0].prepend.is_some(),
        "a session never freed marks the gap"
    );
    assert_eq!(
        answers[0], answers[1],
        "a freed session whose read is quick"
    );
    assert_eq!(answers[0], answers[2], "the freed session's pre_user");
}

/// The minute-long wait after a run-end event is for a worker that has no
/// more work. When the parent writes to the worker again (its next run
/// starts with `pre_user`), the session is in use, and a tool call that runs
/// for more than a minute must not free it in the middle of that run.
#[tokio::test(start_paused = true)]
async fn quiet_review_a_worker_whose_next_run_started_waits_its_whole_quiet_time() {
    let f = Fixture::new("worker", false).await;
    f.notice(1, None, None).await;
    f.module.search_idle(f.key()).await.unwrap();
    // A job that touches no thread, so the clock stays where it is. The
    // paused clock may have freed the session while the search index was
    // waited for; this job starts its worker again.
    f.module.pre_user(f.key(), "next", 0).await;
    assert!(!f.quiet());
    f.client()
        .ends
        .wake(None, &crate::agent_data::source::session_ref(f.key()));
    settle().await;
    // The parent writes to the worker again: its next run starts.
    f.module
        .pre_user(f.key(), "One more thing: fix the lexer too", 0)
        .await;
    tokio::time::advance(QUIET_AFTER_RUN_END + Duration::from_secs(1)).await;
    settle().await;
    assert!(
        !f.quiet(),
        "a worker in its next run was freed a minute after its last job"
    );
}

/// The reader of run-end events falls back to polling when its durable
/// goes away, and wakes every wait so that each reads at once. No run ended
/// then, so no worker may take the wake as its run's end.
#[tokio::test(start_paused = true)]
async fn quiet_review_a_run_end_reader_that_stops_ends_no_run() {
    let f = Fixture::new("worker", false).await;
    f.notice(1, None, None).await;
    f.module.search_idle(f.key()).await.unwrap();
    // Starts the worker again if the paused clock freed the session while
    // the search index was waited for.
    f.module.pre_user(f.key(), "next", 0).await;
    assert!(!f.quiet());
    let ends = &f.client().ends;
    ends.reading();
    ends.stopped("the durable went away");
    settle().await;
    tokio::time::advance(QUIET_AFTER_RUN_END + Duration::from_secs(1)).await;
    settle().await;
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
    let running = || {
        matches!(
            f.module.inner.workers.lock().unwrap().get(&route.session),
            Some(Slot::Running(_))
        )
    };
    assert!(running(), "the tool call started a worker");
    tokio::time::advance(Duration::from_secs(61)).await;
    settle().await;
    for _ in 0..3 {
        tokio::time::advance(QUIET_AFTER).await;
        settle().await;
    }
    assert!(
        !running(),
        "a session that only called tools keeps its worker after three quiet times"
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
    for _ in 0..3 {
        f.wait_quiet_time().await;
    }
    assert!(
        f.quiet(),
        "a session whose last read failed is held after three quiet times"
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
    for f in [&kept, &freed] {
        f.wait_quiet_time().await;
    }
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
