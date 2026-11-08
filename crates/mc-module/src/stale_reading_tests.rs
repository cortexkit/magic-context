//! Readings of a request rendered with an older view than the one the runner
//! applies now.
//!
//! A runner applies a new view while a request may already be in flight;
//! that request's prompt size reaches ck-mc after the new view went out.
//! The reading names the view the request was rendered with
//! (`last_prompt_view`). A version older than the newest one the runner
//! applies, or 0 once a view is applied, is stale: no pressure decision may
//! act on it, or ck-mc builds a second view for pressure the first one
//! already relieved. A reading without a version is used as before, and an
//! over-limit ride still acts on its own estimate.

use super::*;

/// Below the execute threshold (64,350 of the fixture's 99,000 usable).
const BELOW: u64 = 20_000;
/// At the execute threshold, below the force band (84,150).
const EXECUTE: u64 = 70_000;
/// Over the signed-thinking hold's cap (74,250), below the force band.
const PAST_HOLD: u64 = 80_000;
/// In the force band.
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
/// them edits anything, so every lane's work is still to do.
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
/// `view` (`None` when the runner can't say), while the runner applies
/// `applied`.
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

/// A reading of a request rendered with view 1, arriving once the runner
/// applies view 2, builds nothing at the execute threshold: the queued drop
/// keeps waiting. ck-mc keeps the last current reading, not the stale one.
#[tokio::test]
async fn stale_a_reading_under_an_older_view_drives_nothing() {
    let (mut session, client, settings, applied) = under_view_two().await;
    let request = reading(&session, &client, 2, EXECUTE, Some(1), Some(&applied));
    session.notice(&client, &settings, request).await;
    assert!(
        client.offered.lock().unwrap().is_empty(),
        "a stale reading built a view: {:?}",
        client.offered.lock().unwrap()
    );
    assert!(session.queued.contains(&("old".into(), "p2".into())));
    assert!(session.reading_stale);
    assert_eq!(session.conditions.last_prompt_tokens, Some(BELOW));
    assert_eq!(session.conditions.last_prompt_view, Some(2));
}

/// A reading of a request rendered with the view the runner applies counts:
/// at the execute threshold the worker lands its queued drop.
#[tokio::test]
async fn stale_a_reading_under_the_applied_view_counts() {
    let (mut session, client, settings, applied) = under_view_two().await;
    let request = reading(&session, &client, 2, EXECUTE, Some(2), Some(&applied));
    session.notice(&client, &settings, request).await;
    assert!(!session.reading_stale);
    let offered = client.offered.lock().unwrap();
    let view = offered.last().expect("a current reading drives the pass");
    assert!(drops(view, "old", "p2"), "{view:?}");
}

/// Before the runner applies any view, a reading with view 0 is current.
#[tokio::test]
async fn stale_a_reading_with_no_view_counts_before_any_view_is_applied() {
    let (mut session, client, settings) = worker();
    session.queued.insert(("old".into(), "p2".into()));
    let request = reading(&session, &client, 1, EXECUTE, Some(0), None);
    session.notice(&client, &settings, request).await;
    assert!(!session.reading_stale);
    let offered = client.offered.lock().unwrap();
    let view = offered.last().expect("a current reading drives the pass");
    assert!(drops(view, "old", "p2"), "{view:?}");
}

/// Once the runner applies a view, a reading of a request sent with none
/// (view 0) is stale.
#[tokio::test]
async fn stale_a_reading_with_no_view_is_stale_once_a_view_is_applied() {
    let (mut session, client, settings, applied) = under_view_two().await;
    let request = reading(&session, &client, 2, EXECUTE, Some(0), Some(&applied));
    session.notice(&client, &settings, request).await;
    assert!(session.reading_stale);
    assert!(client.offered.lock().unwrap().is_empty());
    assert!(session.queued.contains(&("old".into(), "p2".into())));
}

/// A reading without a view version is used as before, whatever views the
/// runner applied: the view built is the one a session that never tracked
/// applied views builds.
#[tokio::test]
async fn stale_a_reading_without_a_view_version_is_used_as_before() {
    let (mut session, client, settings, applied) = under_view_two().await;
    let (mut untracked, untracked_client, _, _) = under_view_two().await;
    untracked.newest_applied = 0;
    for (session, client) in [(&mut session, &client), (&mut untracked, &untracked_client)] {
        let request = reading(session, client, 2, EXECUTE, None, Some(&applied));
        session.notice(client, &settings, request).await;
        assert!(!session.reading_stale);
    }
    let offered = client.offered.lock().unwrap().clone();
    assert!(
        offered.last().is_some_and(|view| drops(view, "old", "p2")),
        "{offered:?}"
    );
    assert_eq!(offered, *untracked_client.offered.lock().unwrap());
}

/// In the force band, a stale reading runs no emergency drop and builds
/// nothing; the emergency latch stays as it was.
#[tokio::test]
async fn stale_a_reading_in_the_force_band_builds_nothing() {
    let (mut session, client, settings, applied) = under_view_two().await;
    session.queued.clear();
    let request = reading(&session, &client, 2, FORCE, Some(1), Some(&applied));
    session.notice(&client, &settings, request).await;
    assert!(
        client.offered.lock().unwrap().is_empty(),
        "a stale force-band reading built a view: {:?}",
        client.offered.lock().unwrap()
    );
    assert!(!session.emergency_latched);
}

/// An over-limit ride lands on a stale reading: it acts on the runner's own
/// estimate of the request it is about to send. A surface change still
/// rewrites as before.
#[test]
fn stale_rides_that_must_rewrite_still_land_on_a_stale_reading() {
    for causes in [vec![RideCause::OverLimit], vec![RideCause::SurfaceChange]] {
        let (mut session, _, settings) = worker();
        let applied = take_views(&mut session, 2);
        session.queued.insert(("old".into(), "p2".into()));
        let mut conditions = session.conditions.clone();
        conditions.last_prompt_tokens = Some(BELOW);
        conditions.last_prompt_view = Some(1);
        let mut ride = RideRequest::new(causes.clone(), 1_000, conditions);
        ride.applied_view = Some(applied.applied());
        if causes.contains(&RideCause::OverLimit) {
            ride = ride.with_request_tokens(100_000);
        }
        let view = session
            .ride(&settings, &ride)
            .unwrap_or_else(|| panic!("{causes:?} answered nothing"));
        assert!(session.reading_stale, "{causes:?}");
        assert!(drops(&view, "old", "p2"), "{causes:?}: {view:?}");
        if causes.contains(&RideCause::OverLimit) {
            assert!(drops(&view, "old", "p"), "no emergency drop: {view:?}");
        }
    }
}

/// A stale reading leaves the emergency latch alone. Taken as no reading at
/// all, it would release the latch, and the next reading in the force band
/// would take a second emergency batch right after the first.
#[tokio::test]
async fn stale_a_reading_keeps_the_emergency_latch() {
    let (mut session, client, settings, applied) = under_view_two().await;
    session.emergency_latched = true;
    let request = reading(&session, &client, 2, BELOW, Some(1), Some(&applied));
    session.notice(&client, &settings, request).await;
    assert!(session.reading_stale);
    assert!(
        session.emergency_latched,
        "a stale reading released the latch"
    );
}

/// A stale reading leaves the `ctx_keep` request of this stay over the
/// threshold in place, so the model is not asked again because of it.
#[tokio::test]
async fn stale_a_reading_keeps_the_keep_request() {
    let (mut session, client, settings, applied) = under_view_two().await;
    session.keep_requested = true;
    let request = reading(&session, &client, 2, BELOW, Some(1), Some(&applied));
    session.notice(&client, &settings, request).await;
    assert!(session.reading_stale);
    assert!(
        session.keep_requested,
        "a stale reading reset the keep request"
    );
}

/// A stale reading neither clears nor spends the mark that lets the next
/// pass summarize past the newest prompt. The session has a summarizer, so
/// the pass reaches the point where a mark is spent.
#[tokio::test]
async fn stale_a_reading_keeps_the_summary_floor_mark() {
    let (mut session, client, settings, applied) = under_view_two().await;
    session.features.summarizer = true;
    let mark = (5, "go on".to_owned());
    session.floor_pending_for = Some(mark.clone());
    let request = reading(&session, &client, 2, BELOW, Some(1), Some(&applied));
    session.notice(&client, &settings, request).await;
    assert!(session.reading_stale);
    assert_eq!(session.floor_pending_for, Some(mark));
}

/// A worker on a model that binds its thinking to the prefix, whose turn
/// spent `reasoning_tokens` reasoning tokens, and whose history baseline
/// (`m[0]`) was rendered under another head shape, so a fold is pending.
fn heavy_thinking_with_a_pending_fold(reasoning_tokens: u64) -> (Session, Client, Settings) {
    let (mut session, client, _, _, settings) = fixture();
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
    thinking.usage = Some(
        cortexkit_role_compaction::read::StepUsage::default()
            .with_reasoning_tokens(reasoning_tokens),
    );
    let entries = vec![text(1, "task"), thinking];
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries;
    session.index_ready = true;
    let mut shape = session.head_shape(&settings);
    shape.memory_enabled = !shape.memory_enabled;
    session.baseline = Some(Arc::new(Baseline {
        shape: Some(shape),
        ..Baseline::default()
    }));
    (session, client, settings)
}

/// A stale reading can't say whether usage is under the signed-thinking
/// hold's cap. A pending fold waits for a current reading while the turn
/// holds heavy signed thinking, as the hold would make it wait; with light
/// thinking nothing holds it.
#[tokio::test]
async fn stale_a_pending_fold_waits_out_heavy_signed_thinking() {
    let (mut session, client, settings) = heavy_thinking_with_a_pending_fold(2_000);
    let applied = take_views(&mut session, 2);
    let request = reading(&session, &client, 1, PAST_HOLD, Some(1), Some(&applied));
    session.notice(&client, &settings, request).await;
    assert!(session.reading_stale);
    assert!(
        !session.fold_due && !session.head_stale,
        "the fold landed on a stale reading during heavy signed thinking"
    );

    let (mut session, client, settings) = heavy_thinking_with_a_pending_fold(100);
    let applied = take_views(&mut session, 2);
    let request = reading(&session, &client, 1, PAST_HOLD, Some(1), Some(&applied));
    session.notice(&client, &settings, request).await;
    assert!(session.reading_stale);
    assert!(
        session.fold_due || session.head_stale,
        "the fold waited with no heavy thinking to keep"
    );
}

/// The apps keep showing the last current reading as the session's usage,
/// not the stale one.
#[tokio::test]
async fn stale_the_apps_show_the_last_current_reading() {
    let (mut session, client, settings, applied) = under_view_two().await;
    let request = reading(&session, &client, 2, EXECUTE, Some(1), Some(&applied));
    session.notice(&client, &settings, request).await;
    let snapshot = session.app_snapshot();
    assert_eq!(snapshot.breakdown["total"]["tokens"], BELOW);
    assert_eq!(snapshot.breakdown["total"]["source"], "provider");
}

/// With no current reading to keep, the apps don't fall back to the newest
/// step's own usage either: that step is the stale request. They show the
/// estimate.
#[tokio::test]
async fn stale_with_no_earlier_reading_the_apps_show_the_estimate() {
    let (mut session, client, settings) = worker();
    let mut step = Entry::new(
        6,
        "reply",
        Role::Assistant,
        6,
        vec![Part::new(
            "t",
            PartBody::Text {
                text: "Done.".into(),
            },
        )],
    );
    step.usage =
        Some(cortexkit_role_compaction::read::StepUsage::default().with_prompt_tokens(EXECUTE));
    session.index.extend(vec![step.clone()]);
    client.entries.lock().unwrap().push(step);
    let applied = take_views(&mut session, 2);
    let request = reading(&session, &client, 1, EXECUTE, Some(1), Some(&applied));
    session.notice(&client, &settings, request).await;
    assert!(session.reading_stale);
    assert_eq!(session.conditions.last_prompt_tokens, None);
    let snapshot = session.app_snapshot();
    assert_eq!(snapshot.breakdown["total"]["source"], "estimate");
    assert_ne!(snapshot.breakdown["total"]["tokens"], EXECUTE);
}

/// An over-limit ride after a stale reading sizes its emergency drop from
/// the runner's estimate of the request it is about to send, not from the
/// reading the stored conditions kept from before the newest view. Sized
/// from that larger reading, the part of the prompt outside the transcript
/// would look bigger than the threshold and the drop would take nothing.
#[test]
fn stale_an_over_limit_ride_sizes_its_emergency_drop_from_its_own_estimate() {
    let (mut session, _, settings) = worker();
    let applied = take_views(&mut session, 2);
    session.conditions.last_prompt_tokens = Some(130_000);
    session.conditions.last_prompt_view = Some(1);
    let mut conditions = session.conditions.clone();
    conditions.last_prompt_tokens = Some(FORCE);
    conditions.last_prompt_view = Some(1);
    let mut ride = RideRequest::new(vec![RideCause::OverLimit], 1_000, conditions)
        .with_request_tokens(100_000);
    ride.applied_view = Some(applied.applied());
    let view = session
        .ride(&settings, &ride)
        .expect("an over-limit request must shrink");
    assert!(session.reading_stale);
    assert_eq!(session.conditions.last_prompt_tokens, Some(130_000));
    assert!(
        drops(&view, "old", "p"),
        "the emergency drop was not sized from the ride's estimate: {view:?}"
    );
}

/// Log output, for counting warnings.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The in-flight request's reading may repeat, and stays ignored. A
/// different reading that still names a view the runner replaced was
/// measured on a request sent later: the runner is at fault. ck-mc warns
/// once, counts its readings whatever view they name, and judges them again
/// after the next Setup.
#[tokio::test]
async fn stale_a_second_different_stale_reading_distrusts_the_runner_until_setup() {
    let output = Captured::default();
    let writer = output.clone();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    let _logging = tracing::subscriber::set_default(subscriber);

    let (mut session, client, settings, applied) = under_view_two().await;
    for seq in [2, 3] {
        let request = reading(&session, &client, seq, EXECUTE, Some(1), Some(&applied));
        session.notice(&client, &settings, request).await;
        assert!(
            session.reading_stale,
            "a repeat of the ignored reading counted"
        );
    }
    assert!(client.offered.lock().unwrap().is_empty());

    for (seq, prompt) in [(4, EXECUTE + 1_000), (5, EXECUTE + 2_000)] {
        let request = reading(&session, &client, seq, prompt, Some(1), Some(&applied));
        session.notice(&client, &settings, request).await;
        assert!(!session.reading_stale, "{prompt}");
        assert!(session.prompt_views_untrusted, "{prompt}");
    }
    let offered = client.offered.lock().unwrap().clone();
    assert!(
        offered.first().is_some_and(|view| drops(view, "old", "p2")),
        "the reading that showed the fault did not count: {offered:?}"
    );
    let logs = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
    assert_eq!(
        logs.matches("a second stale reading").count(),
        1,
        "exactly one warning: {logs}"
    );
    assert!(logs.contains("WARN"), "{logs}");

    let (_, _, route, request, _) = fixture();
    let mut setup = request;
    setup.applied_view = Some(applied.applied());
    setup.newest = client.entries.lock().unwrap().last().map(cursor);
    let features = session.features;
    session
        .setup(&client, &settings, &route, &setup, features)
        .await;
    assert!(!session.prompt_views_untrusted);
    let request = reading(&session, &client, 1, EXECUTE, Some(1), Some(&applied));
    session.notice(&client, &settings, request).await;
    assert!(
        session.reading_stale,
        "after Setup a reading under a replaced view is ignored again"
    );
}

/// The newest applied version and whether the reading is stale survive a
/// restart; a row saved before they existed restores as nothing applied.
#[tokio::test]
async fn stale_judgement_survives_a_restart() {
    let (mut session, client, settings, applied) = under_view_two().await;
    let request = reading(&session, &client, 2, EXECUTE, Some(1), Some(&applied));
    session.notice(&client, &settings, request).await;
    let durable = session.durable();
    let (mut restored, _, _, _, _) = fixture();
    restored.restore(durable.clone());
    assert_eq!(restored.newest_applied, 2);
    assert!(restored.reading_stale);
    assert_eq!(restored.ignored_reading, Some((EXECUTE, 1, 2)));
    assert!(!restored.prompt_views_untrusted);

    let mut older = serde_json::to_value(&durable).unwrap();
    let fields = older.as_object_mut().unwrap();
    for field in [
        "newest_applied",
        "reading_stale",
        "ignored_reading",
        "prompt_views_untrusted",
    ] {
        fields.remove(field);
    }
    let older: crate::store::Durable = serde_json::from_value(older).unwrap();
    assert_eq!(
        (
            older.newest_applied,
            older.reading_stale,
            older.ignored_reading,
            older.prompt_views_untrusted
        ),
        (0, false, None, false)
    );
}

/// The runner's own answer to `session.applied_view` replaces the newest
/// version: a runner whose state went back measures under the view it
/// applies, and its readings must not all look stale.
#[tokio::test]
async fn stale_a_runner_that_went_back_is_believed() {
    let (mut session, client, settings, _) = under_view_two().await;
    // The runner reports applying a view ck-mc doesn't expect.
    let older = View::seal(1, Vec::new());
    let mut answer = AppliedViewAnswer::new();
    answer.view = Some(older.clone());
    *client.applied.lock().unwrap() = Some(answer);
    let request = reading(&session, &client, 2, BELOW, Some(1), Some(&older));
    session.notice(&client, &settings, request).await;
    assert_eq!(session.newest_applied, 1);
    let request = reading(&session, &client, 3, BELOW, Some(1), Some(&older));
    session.notice(&client, &settings, request).await;
    assert!(!session.reading_stale);
}
