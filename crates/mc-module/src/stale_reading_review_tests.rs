//! Witnesses and probes for readings judged by `last_prompt_view`.
//!
//! Witnesses cover a runner that keeps naming views it replaced, and one
//! whose applied view goes back or away. Probes check behaviour that already
//! holds, each with a control showing the test could fail.

use super::*;

/// Below the execute threshold (64,350 of the fixture's 99,000 usable).
const BELOW: u64 = 20_000;
/// At the execute threshold, below the force band (84,150).
const EXECUTE: u64 = 70_000;
/// In the force band, below the usable window.
const FORCE: u64 = 90_000;

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

/// A worker with two large old outputs (`old`/`p`, `old`/`p2`) and three
/// newer ones, whose runner holds the same transcript.
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
    (session, client, settings)
}

/// Hand `count` views to the runner, each taken; returns the newest. None of
/// them edits anything.
fn take_views(session: &mut Session, count: u64) -> View {
    let mut newest = None;
    for _ in 0..count {
        let view = session.seal_unchecked(Vec::new());
        session.accept(view.clone());
        newest = Some(view);
    }
    newest.expect("at least one view")
}

/// A notice carrying a reading of `prompt` tokens, measured under view
/// `view`, while the runner applies `applied`.
fn reading(
    session: &Session,
    client: &Client,
    seq: u64,
    prompt: u64,
    view: Option<u64>,
    applied: Option<&View>,
) -> NoticeRequest {
    let newest = client.entries.lock().unwrap().last().map(cursor);
    let mut request = notice(session, seq, newest);
    request.conditions.last_prompt_tokens = Some(prompt);
    request.conditions.last_prompt_view = view;
    request.applied_view = applied.map(View::applied);
    request
}

/// A worker whose runner applies view 2, with the model's drop of `old`/`p2`
/// queued and a current reading below the threshold already taken.
async fn under_view_two() -> (Session, Client, Settings, View) {
    let (mut session, client, settings) = worker();
    let applied = take_views(&mut session, 2);
    session.queued.insert(("old".into(), "p2".into()));
    let request = reading(&session, &client, 1, BELOW, Some(2), Some(&applied));
    session.notice(&client, &settings, request).await;
    assert_eq!(session.newest_applied, 2);
    assert!(!session.reading_stale);
    assert!(client.offered.lock().unwrap().is_empty());
    (session, client, settings, applied)
}

/// The runner writes one more step; the next notice reports it.
fn grow(client: &Client, ordinal: u64) {
    client
        .entries
        .lock()
        .unwrap()
        .push(text(ordinal, &format!("step {ordinal}")));
}

fn offered(client: &Client) -> Vec<View> {
    client.offered.lock().unwrap().clone()
}

/// Whether `view` drops or replaces the part `mid`/`part`.
fn drops(view: &View, mid: &str, part: &str) -> bool {
    view.edits.iter().any(|edit| match &edit.op {
        EditOp::Drop { mid: m, part: None } => m == mid,
        EditOp::Drop {
            mid: m,
            part: Some(p),
        }
        | EditOp::Replace {
            mid: m, part: p, ..
        } => m == mid && p == part,
        _ => false,
    })
}

/// Witness. A runner with a bug keeps naming an old view in every reading
/// while it applies view 2. A correct runner has at most one request in
/// flight per session when it applies a view, so after a view change it can
/// send only one distinct stale reading (repeated across that request's
/// notices). The second distinct one shows the runner at fault, and from
/// then on its readings count: ck-mc must not stay blind to five growing
/// readings in the force band, which only an over-limit ride would reach.
#[tokio::test]
async fn review_stale_readings_stuck_under_an_old_view_stop_pressure_for_good() {
    let (mut session, client, settings, applied) = under_view_two().await;
    for (seq, ordinal) in (2..=6).zip(6..) {
        grow(&client, ordinal);
        let prompt = FORCE + seq * 1_000;
        let request = reading(&session, &client, seq, prompt, Some(1), Some(&applied));
        session.notice(&client, &settings, request).await;
    }
    assert!(
        !offered(&client).is_empty(),
        "five growing force-band readings, none under the applied view: ck-mc never acted"
    );
}

/// Witness. A runner whose state went back reports applying view 1 while
/// ck-mc remembers view 2 applied. Its reading, measured under view 1, is the
/// view it now applies, so it is current already on the notice that reports
/// the change, before `adopt_runner_view` reads the view back.
#[tokio::test]
async fn review_stale_the_first_reading_after_the_runner_went_back_counts() {
    let (mut session, client, settings, _) = under_view_two().await;
    let older = View::seal(1, Vec::new());
    let mut answer = AppliedViewAnswer::new();
    answer.view = Some(older.clone());
    *client.applied.lock().unwrap() = Some(answer);
    let request = reading(&session, &client, 2, EXECUTE, Some(1), Some(&older));
    session.notice(&client, &settings, request).await;
    assert_eq!(session.newest_applied, 1);
    assert!(
        !session.reading_stale,
        "a reading under the view the runner applies was judged stale"
    );
    let views = offered(&client);
    assert!(
        views.last().is_some_and(|view| drops(view, "old", "p2")),
        "{views:?}"
    );
}

/// Witness. ck-mc took a foreign module's view 3 as the runner's
/// (`adopt_runner_view` keeps its version and no view of its own), then the
/// runner stops applying any view. `runner_differs` sees nothing applied and
/// no view of ck-mc's own, so no read-back happens; the notices' absent
/// `applied_view` itself says the runner applies none, so readings under no
/// view (0) are current.
#[tokio::test]
async fn review_stale_no_view_after_a_foreign_one_is_not_stale_for_good() {
    let (mut session, client, settings) = worker();
    session.queued.insert(("old".into(), "p2".into()));
    let foreign = View::seal(3, Vec::new());
    let mut answer = AppliedViewAnswer::new();
    answer.view = Some(foreign.clone());
    answer.applied_by = Some("other-module".into());
    *client.applied.lock().unwrap() = Some(answer);
    let request = reading(&session, &client, 1, BELOW, Some(3), Some(&foreign));
    session.notice(&client, &settings, request).await;
    assert_eq!(session.newest_applied, 3);
    assert!(session.latest.is_none());

    // The runner applies no view from now on.
    *client.applied.lock().unwrap() = None;
    for (seq, ordinal) in (2..=4).zip(6..) {
        grow(&client, ordinal);
        let request = reading(&session, &client, seq, EXECUTE, Some(0), None);
        session.notice(&client, &settings, request).await;
    }
    assert!(
        !session.reading_stale,
        "readings under no view stay stale while the runner applies none"
    );
    assert!(!offered(&client).is_empty());
}

/// Probe. A ride whose causes only say the provider forgot its cache gets no
/// permission from a stale reading at the execute threshold. Control: the
/// same ride with a current reading lands the queued drop.
#[tokio::test]
async fn review_stale_a_forgotten_cache_ride_gets_no_permission() {
    for causes in [vec![RideCause::CacheExpired], vec![RideCause::ChainReset]] {
        for (view, permitted) in [(1, false), (2, true)] {
            let (mut session, _, settings, applied) = under_view_two().await;
            let mut conditions = session.conditions.clone();
            conditions.last_prompt_tokens = Some(EXECUTE);
            conditions.last_prompt_view = Some(view);
            let mut ride = RideRequest::new(causes.clone(), 1_000, conditions);
            ride.applied_view = Some(applied.applied());
            let answer = session.ride(&settings, &ride);
            assert_eq!(session.reading_stale, !permitted, "{causes:?} {view}");
            assert_eq!(answer.is_some(), permitted, "{causes:?} {view}: {answer:?}");
        }
    }
}

/// Probe. In the real sequence the reading that built a view is the one a
/// stale reading falls back to: a current reading at the execute threshold
/// builds view 3, the runner applies it, and the in-flight request's
/// reading under view 2 arrives. The stored conditions go back to the
/// execute-level reading under view 2; `pressure()` must hide it too, or
/// the next queued drop lands in a second view at once.
#[tokio::test]
async fn review_stale_the_reading_that_built_the_view_drives_nothing_again() {
    let (mut session, client, settings, applied) = under_view_two().await;
    let request = reading(&session, &client, 2, EXECUTE, Some(2), Some(&applied));
    session.notice(&client, &settings, request).await;
    let built = offered(&client);
    assert_eq!(built.len(), 1, "the current reading built no view");
    let third = built[0].clone();

    session.queued.insert(("newer".into(), "q".into()));
    grow(&client, 6);
    let request = reading(&session, &client, 3, EXECUTE + 2_000, Some(2), Some(&third));
    session.notice(&client, &settings, request).await;
    assert!(session.reading_stale);
    assert_eq!(session.newest_applied, third.version);
    assert_eq!(session.conditions.last_prompt_tokens, Some(EXECUTE));
    assert_eq!(
        offered(&client).len(),
        1,
        "a second view followed the first"
    );

    // Control: the next reading under view 3 drives the pass again.
    grow(&client, 7);
    let request = reading(
        &session,
        &client,
        4,
        EXECUTE,
        Some(third.version),
        Some(&third),
    );
    session.notice(&client, &settings, request).await;
    assert!(!session.reading_stale);
    assert_eq!(offered(&client).len(), 2);
}

/// Probe. Setup carries no reading, so it clears a stale judgement, and it
/// keeps the newest applied version: a reading under an older view after it
/// is still stale.
#[tokio::test]
async fn review_stale_setup_clears_the_judgement_and_keeps_the_version() {
    let (mut session, client, route, request, settings) = fixture();
    let entries = vec![
        text(1, "task"),
        tools(2, "old", &[("p", 10), ("p2", 11)]),
        text(3, "next"),
    ];
    *client.entries.lock().unwrap() = entries.clone();
    session.index.extend(entries);
    session.index_ready = true;
    let applied = take_views(&mut session, 2);
    let stale = reading(&session, &client, 1, EXECUTE, Some(1), Some(&applied));
    session.notice(&client, &settings, stale).await;
    assert!(session.reading_stale);

    let mut setup = request.clone();
    setup.applied_view = Some(applied.applied());
    setup.newest = client.entries.lock().unwrap().last().map(cursor);
    let features = session.features;
    session
        .setup(&client, &settings, &route, &setup, features)
        .await;
    assert!(!session.reading_stale);
    assert_eq!(session.newest_applied, 2);
    assert_eq!(session.conditions.last_prompt_tokens, None);

    let stale = reading(&session, &client, 1, EXECUTE, Some(1), Some(&applied));
    session.notice(&client, &settings, stale).await;
    assert!(session.reading_stale);
}

/// A worker on a model that binds its thinking to the prefix, whose turn
/// spent 2,000 reasoning tokens, and whose history head (`m[0]`, the first
/// message of the request, which shows the summaries and memories) was
/// rendered under another head shape, so a fold is pending.
fn heavy_thinking_with_a_pending_fold() -> (Session, Settings) {
    let (mut session, _, _, _, settings) = fixture();
    session.conditions.rules = ProviderRules::new(SignedParts::Bound, EditCost::Suffix);
    let reasoning: Part = serde_json::from_value(serde_json::json!({
        "id":"r", "kind":"reasoning", "text_bytes":400, "digest":""
    }))
    .unwrap();
    let mut thinking = Entry::new(
        2,
        "think",
        Role::Assistant,
        2,
        vec![reasoning, output_part("t", 2)],
    );
    thinking.usage =
        Some(cortexkit_role_compaction::read::StepUsage::default().with_reasoning_tokens(2_000));
    session.index.extend(vec![text(1, "task"), thinking]);
    session.index_ready = true;
    let mut shape = session.head_shape(&settings);
    shape.memory_enabled = !shape.memory_enabled;
    session.baseline = Some(Arc::new(Baseline {
        shape: Some(shape),
        ..Baseline::default()
    }));
    (session, settings)
}

/// Probe. A ride whose request's bytes before the conversation change
/// anyway (`surface_change`, `model_change`) takes a pending head-shape fold
/// on a stale reading, heavy signed thinking or not. Control: a
/// forgotten-cache ride under the same conditions leaves the fold waiting and
/// answers nothing. The prefix rides publish no view in this fixture either
/// (it has nothing to drop), so the fold is read from `fold_due`.
#[test]
fn review_stale_prefix_rides_still_fold_on_a_stale_reading() {
    for (causes, folds) in [
        (vec![RideCause::SurfaceChange], true),
        (vec![RideCause::ModelChange], true),
        (vec![RideCause::CacheExpired], false),
    ] {
        let (mut session, settings) = heavy_thinking_with_a_pending_fold();
        let applied = take_views(&mut session, 2);
        assert!(session.head_shape_changed(&settings));
        let mut conditions = session.conditions.clone();
        conditions.last_prompt_tokens = Some(EXECUTE);
        conditions.last_prompt_view = Some(1);
        let mut ride = RideRequest::new(causes.clone(), 1_000, conditions);
        ride.applied_view = Some(applied.applied());
        let answer = session.ride(&settings, &ride);
        assert!(session.reading_stale, "{causes:?}");
        assert_eq!(session.fold_due, folds, "{causes:?}");
        if !folds {
            assert!(
                answer.is_none() && !session.head_stale,
                "{causes:?}: {answer:?}"
            );
        }
    }
}
