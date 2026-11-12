//! Review witnesses for statement order: a notice or ride whose
//! `statement_seq` stamp is below the highest one ck-mc took for the session
//! was built from older runner state, though it arrived later (a background
//! notice that a ride overtook).
//!
//! Each `review_` test below states a property the late-statement rules
//! should keep and fails while ck-mc breaks it; the `review_guard_` test
//! passes and pins a case the existing tests never ran on its own. Every
//! test collects the properties that fail instead of stopping at the first
//! one, so a run names all of them. The tests use only helpers that predate
//! ck-mc's handling of the stamp, so they also run on a checkout whose
//! contract crate carries the stamp but whose ck-mc does not handle it yet.

use super::*;

/// In the force band (85% or more of the fixture's 99,000 usable tokens,
/// where queued work lands at once).
const FORCE: u64 = 90_000;

/// Records `what` when `holds` is false.
fn expect(failures: &mut Vec<String>, holds: bool, what: impl Into<String>) {
    if !holds {
        failures.push(what.into());
    }
}

fn tools(ordinal: u64, mid: &str, parts: &[(&str, u64)]) -> Entry {
    Entry::new(
        ordinal,
        mid,
        Role::Assistant,
        ordinal,
        parts
            .iter()
            .map(|(id, tag)| output_part(id, *tag))
            .collect(),
    )
}

/// A worker session with two old tool outputs and three newer ones, whose
/// runner holds the same transcript, with the model's drop of `old`/`p2`
/// queued.
fn worker() -> (Session, Client, Settings) {
    let (mut session, client, _, _, settings) = fixture();
    let entries = vec![
        text(1, "task"),
        tools(2, "old", &[("p", 10), ("p2", 11)]),
        text(3, "next"),
        tools(4, "newer", &[("q", 12), ("r", 13), ("s", 14)]),
        text(5, "go on"),
    ];
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries;
    session.index_ready = true;
    session.queued.insert(("old".into(), "p2".into()));
    // A runner that stamps marks its statements with the epoch of the
    // Setup they were built under; ck-mc drops a stamped one without it.
    session.statement_epoch = Some("review-epoch".into());
    (session, client, settings)
}

/// Hand the runner a view, which it takes; it applies it from its next step.
fn take_view(session: &mut Session) -> View {
    let view = session.seal_unchecked(Vec::new());
    session.accept(view.clone());
    session.runner_holds(view.version);
    view
}

/// A ride with no cause, stamped `stamp`, while the runner applies
/// `applied`, carrying a reading of `prompt` tokens measured under view
/// `measured` (no reading when `prompt` is `None`).
fn ride(
    session: &Session,
    stamp: u64,
    applied: &View,
    prompt: Option<u64>,
    measured: u64,
) -> RideRequest {
    let mut conditions = session.conditions.clone();
    conditions.statement_epoch = session.statement_epoch.clone();
    conditions.statement_seq = Some(stamp);
    conditions.last_prompt_tokens = prompt;
    conditions.last_prompt_view = prompt.map(|_| measured);
    let mut ride = RideRequest::new(Vec::new(), 1_000, conditions);
    ride.applied_view = Some(applied.applied());
    ride
}

/// A notice stamped `stamp`, numbered `seq`, while the runner applied
/// `applied`, carrying a reading of `prompt` tokens measured under view
/// `measured` (no reading when `prompt` is `None`).
fn late_notice(
    session: &Session,
    client: &Client,
    seq: u64,
    stamp: u64,
    applied: &View,
    prompt: Option<u64>,
    measured: u64,
) -> NoticeRequest {
    let newest = client.entries.lock().unwrap().last().map(cursor);
    let mut request = notice(session, seq, newest);
    request.conditions.statement_seq = Some(stamp);
    request.conditions.last_prompt_tokens = prompt;
    request.conditions.last_prompt_view = prompt.map(|_| measured);
    request.applied_view = Some(applied.applied());
    request
}

/// The runner applies view 2 and says so in a ride stamped 9, whose
/// reading (60,000 tokens) measured the request that was in flight when
/// view 2 took force, under view 1: ck-mc ignores it as older than view 2.
/// A notice stamped 7, built before that ride while the runner still
/// applied view 1, arrives after it with the reading before that one
/// (90,000 tokens, also under view 1).
///
/// Both readings measured requests sent under view 1 before view 2 took
/// force, and the stamps say so: the late one is older still, not a second
/// request the runner rendered with a view it had replaced. It must be
/// stale like the first, and must not make ck-mc disregard the runner's
/// view versions (`prompt_views_untrusted`), which lasts until the next
/// Setup and lets every later reading under a replaced view count.
#[tokio::test]
async fn review_a_late_reading_under_a_replaced_view_keeps_view_versions_trusted() {
    let (mut session, client, settings) = worker();
    let first = take_view(&mut session);
    let second = take_view(&mut session);
    let newer = ride(&session, 9, &second, Some(60_000), first.version);
    assert!(session.ride(&settings, &newer).is_none());
    assert_eq!(session.newest_applied, second.version);
    assert!(
        session.reading_stale,
        "precondition: the ride's reading is stale"
    );
    let late = late_notice(&session, &client, 1, 7, &first, Some(FORCE), first.version);
    session.notice(&client, &settings, late).await;
    let mut failures = Vec::new();
    expect(
        &mut failures,
        !session.prompt_views_untrusted,
        "the late notice made ck-mc disregard the runner's view versions",
    );
    expect(
        &mut failures,
        session.reading_stale,
        "the late reading under view 1 counted while the runner applies view 2",
    );
    let offered = client.offered.lock().unwrap().len();
    expect(
        &mut failures,
        offered == 0,
        format!("the late reading built and offered {offered} view(s)"),
    );
    assert!(failures.is_empty(), "{failures:#?}");
}

/// The runner applies view 1. A ride stamped 9 carries a reading in the
/// force band (90,000 tokens, under view 1) and its answer, view 2, lands
/// the queued drop; the runner takes it. The model then queues another
/// drop. Two notices the ride overtook arrive after it: one stamped 7 with
/// the reading before the ride's (80,000 tokens), then one stamped 8 with
/// the ride's own reading (90,000 tokens), both under view 1.
///
/// Both measured requests sent before the runner took view 2, and the
/// stamps say so; neither is a request the runner rendered without the
/// view it accepted. Both must be stale, view 2 must keep counting as
/// accepted, and the reading view 2 was already built on must not build a
/// second view.
#[tokio::test]
async fn review_two_late_readings_keep_the_accepted_view_counting() {
    let (mut session, client, settings) = worker();
    let first = take_view(&mut session);
    let newer = ride(&session, 9, &first, Some(FORCE), first.version);
    let answer = session
        .ride(&settings, &newer)
        .expect("precondition: the ride's pass lands the queued drop");
    session.queued.insert(("newer".into(), "q".into()));
    let older = late_notice(&session, &client, 1, 7, &first, Some(80_000), first.version);
    session.notice(&client, &settings, older).await;
    let mut failures = Vec::new();
    expect(
        &mut failures,
        session.reading_stale,
        "the notice stamped 7 counted its reading from before view 2",
    );
    let late = late_notice(&session, &client, 2, 8, &first, Some(FORCE), first.version);
    session.notice(&client, &settings, late).await;
    expect(
        &mut failures,
        session.reading_stale,
        "the notice stamped 8 counted the reading view 2 was built on",
    );
    expect(
        &mut failures,
        session
            .unconfirmed
            .iter()
            .any(|waiting| waiting.view.version == answer.version && waiting.accepted),
        "view 2 no longer counts as accepted",
    );
    let offered = client.offered.lock().unwrap().len();
    expect(
        &mut failures,
        offered == 0,
        format!("a late reading built and offered {offered} view(s) on top of view 2"),
    );
    assert!(failures.is_empty(), "{failures:#?}");
}

/// A ride stamped 9 carries a reading in the force band, and the model was
/// already asked to call `ctx_keep` during this stay over the threshold. A
/// notice stamped 7, built before the runner had any reading to send (or
/// while the newest request had no usage report), arrives after it.
///
/// The late notice's missing reading is older runner state, not news that
/// usage is unknown now: ck-mc must keep the ride's reading, and with it
/// the `ctx_keep` request (otherwise the next pass over the threshold asks
/// the model again).
#[tokio::test]
async fn review_a_late_statement_without_a_reading_keeps_the_newer_reading() {
    let (mut session, client, settings) = worker();
    let first = take_view(&mut session);
    session.keep_requested = true;
    let newer = ride(&session, 9, &first, Some(FORCE), first.version);
    let _ = session.ride(&settings, &newer);
    assert_eq!(
        session.conditions.last_prompt_tokens,
        Some(FORCE),
        "precondition: the ride's reading is taken"
    );
    assert!(
        session.keep_requested,
        "precondition: a ride keeps the request"
    );
    let late = late_notice(&session, &client, 1, 7, &first, None, 0);
    session.notice(&client, &settings, late).await;
    let mut failures = Vec::new();
    expect(
        &mut failures,
        session.conditions.last_prompt_tokens == Some(FORCE),
        format!(
            "the late notice replaced the ride's reading with {:?}",
            session.conditions.last_prompt_tokens
        ),
    );
    expect(
        &mut failures,
        session.keep_requested,
        "the late notice released the ctx_keep request",
    );
    assert!(failures.is_empty(), "{failures:#?}");
}

/// The case of `order_a_late_notice_naming_an_older_applied_view_changes_no_view`
/// in which `session.applied_view` fails, run on its own: in that test's
/// loop it comes after cases that fail first wherever the late notice is
/// taken in arrival order, so it never ran red there. Passes once a late
/// notice's applied view is set aside.
#[tokio::test]
async fn review_guard_late_notice_with_failing_read_back_changes_no_view() {
    for older in [0, 1] {
        let case = format!("named view {older}");
        let (mut session, client, settings) = worker();
        let views: Vec<View> = (0..=older).map(|_| take_view(&mut session)).collect();
        let applied = views.last().expect("a view").clone();
        let newer = ride(&session, 9, &applied, None, 0);
        assert!(session.ride(&settings, &newer).is_none(), "{case}");
        let pending = take_view(&mut session);
        let mut answer = AppliedViewAnswer::new();
        answer.view = Some(applied.clone());
        *client.applied.lock().unwrap() = Some(answer);
        *client.fail_applied_view.lock().unwrap() = true;
        let newest = client.entries.lock().unwrap().last().map(cursor);
        let mut late = notice(&session, 1, newest);
        late.conditions.statement_seq = Some(7);
        late.conditions.last_prompt_tokens = Some(FORCE);
        late.conditions.last_prompt_view = Some(older);
        late.applied_view = views
            .iter()
            .find(|view| view.version == older)
            .map(View::applied);
        session.notice(&client, &settings, late).await;
        let mut failures = Vec::new();
        expect(
            &mut failures,
            session.newest_applied == applied.version,
            format!(
                "applied version set back to {} from {}",
                session.newest_applied, applied.version
            ),
        );
        expect(
            &mut failures,
            session.latest.as_ref().map(|view| view.version) == Some(pending.version),
            format!(
                "newest view is {:?}, not the accepted {}",
                session.latest.as_ref().map(|view| view.version),
                pending.version
            ),
        );
        expect(
            &mut failures,
            session
                .unconfirmed
                .iter()
                .any(|waiting| waiting.view.version == pending.version && waiting.accepted),
            "the accepted view is no longer waiting",
        );
        expect(
            &mut failures,
            session.conditions.last_prompt_tokens.is_none()
                && session.conditions.last_prompt_view.is_none(),
            "the late notice's reading replaced the ride's, which had none",
        );
        let offered = client.offered.lock().unwrap().len();
        expect(
            &mut failures,
            offered == 0,
            format!("{offered} view(s) offered"),
        );
        assert!(failures.is_empty(), "{case}: {failures:#?}");
    }
}
