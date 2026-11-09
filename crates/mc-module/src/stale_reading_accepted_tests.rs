//! Readings under the view before one the runner accepted but has not
//! applied yet.
//!
//! A runner keeps a view it accepted pending until its next step, and until
//! then reports the view before it as applied. Every request it renders after
//! accepting carries the accepted view, so a reading under the older view
//! measured a request sent before the runner took the new one. Acting on it
//! would build a second view for pressure the accepted one already relieves.
//! A view the runner refused, or one ck-mc rolled back, stops counting at
//! once. Such readings are normal runner behaviour, so they never count
//! toward the check that stops trusting the views a runner names.

use super::*;

/// 76% of the fixture's 99,000 usable tokens: over the execute threshold
/// (64,350), below the force band (84,150).
const HIGH: u64 = 75_240;
/// 31%: below the execute threshold.
const LOW: u64 = 30_690;

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

/// A notice carrying a reading of `prompt` tokens, measured under view
/// `view`, while the runner applies `applied`.
fn reading(
    session: &Session,
    client: &Client,
    seq: u64,
    prompt: u64,
    view: u64,
    applied: &View,
) -> NoticeRequest {
    let newest = client.entries.lock().unwrap().last().map(cursor);
    let mut request = notice(session, seq, newest);
    request.conditions.last_prompt_tokens = Some(prompt);
    request.conditions.last_prompt_view = Some(view);
    request.applied_view = Some(applied.applied());
    request
}

/// A worker whose runner applies view 18 under a current reading below the
/// threshold, with the model's drop of `old`/`p2` queued afterwards: a
/// current reading at the execute threshold lands it in a new view.
async fn under_view_eighteen() -> (Session, Client, Settings, View) {
    let (mut session, client, settings) = worker();
    let mut applied = None;
    for _ in 0..18 {
        let view = session.seal_unchecked(Vec::new());
        session.accept(view.clone());
        applied = Some(view);
    }
    let applied = applied.expect("view 18");
    let request = reading(&session, &client, 1, LOW, 18, &applied);
    session.notice(&client, &settings, request).await;
    assert_eq!(session.newest_applied, 18);
    assert!(session.unconfirmed.is_empty());
    assert!(!session.reading_stale);
    assert!(offered(&client).is_empty());
    session.queued.insert(("old".into(), "p2".into()));
    (session, client, settings, applied)
}

/// ck-mc publishes the next view (19), which carries no edit, and the
/// runner's answer to `session.apply_view` accepts it.
async fn hand_over(session: &mut Session, client: &Client) -> View {
    let view = session.seal_unchecked(Vec::new());
    assert_eq!(view.version, 19);
    session.publish(client, view.clone()).await;
    assert_eq!(offered(client).last(), Some(&view));
    assert_eq!(session.latest.as_ref(), Some(&view));
    view
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

/// Log output, for reading the lines ck-mc writes.
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

impl Captured {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
}

/// Capture this thread's log lines until the guard drops.
fn capture() -> (Captured, tracing::subscriber::DefaultGuard) {
    let output = Captured::default();
    let writer = output.clone();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    (output, tracing::subscriber::set_default(subscriber))
}

/// The order seen on a live runner: ck-mc publishes view 19 and the runner
/// accepts it; then the notice for a request rendered before that arrives,
/// reporting view 18 applied and measured under view 18, at 76%. It builds
/// nothing, and the log says the accepted view made it stale. The runner's
/// first reading under view 19 then counts as usual, and so do the ones
/// after it.
#[tokio::test]
async fn stale_accepted_a_reading_from_before_the_runner_took_the_view_builds_nothing() {
    let (logs, _logging) = capture();
    let (mut session, client, settings, eighteen) = under_view_eighteen().await;
    let nineteen = hand_over(&mut session, &client).await;

    let request = reading(&session, &client, 2, HIGH, 18, &eighteen);
    session.notice(&client, &settings, request).await;
    assert_eq!(
        offered(&client),
        vec![nineteen.clone()],
        "a reading from before the runner took view 19 built another view"
    );
    assert!(session.reading_stale);
    assert!(session.queued.contains(&("old".into(), "p2".into())));
    assert_eq!(session.conditions.last_prompt_tokens, Some(LOW));
    assert!(!session.prompt_views_untrusted);
    let logs = logs.text();
    assert!(
        logs.contains(&format!(
            "ignoring a prompt of {HIGH} tokens: reading from view 18, newest applied 18, accepted 19;"
        )),
        "{logs}"
    );

    // The runner renders view 19 at its next step.
    let request = reading(&session, &client, 3, LOW, 19, &nineteen);
    session.notice(&client, &settings, request).await;
    assert!(!session.reading_stale);
    assert_eq!(session.newest_applied, 19);
    assert!(session.unconfirmed.is_empty());
    assert_eq!(session.conditions.last_prompt_tokens, Some(LOW));
    assert_eq!(offered(&client).len(), 1, "a reading below the threshold");

    let request = reading(&session, &client, 4, HIGH, 19, &nineteen);
    session.notice(&client, &settings, request).await;
    assert!(!session.reading_stale);
    let views = offered(&client);
    assert!(
        views.len() == 2 && drops(&views[1], "old", "p2"),
        "a current reading at the threshold did not land the queued drop: {views:?}"
    );
}

/// A view the runner refuses at its step boundary stops counting in the
/// same notice: the reading under the view before it is current again, and
/// at the threshold it lands the queued drop.
#[tokio::test]
async fn stale_accepted_a_view_refused_at_the_step_boundary_stops_counting_at_once() {
    let (mut session, client, settings, eighteen) = under_view_eighteen().await;
    let nineteen = hand_over(&mut session, &client).await;
    let mut request = reading(&session, &client, 2, HIGH, 18, &eighteen);
    request.events.push(Event::ViewRefused {
        version: nineteen.version,
        refusal: ViewRefusal::BadSince,
    });
    session.notice(&client, &settings, request).await;
    assert!(!session.reading_stale);
    assert_eq!(session.conditions.last_prompt_tokens, Some(HIGH));
    let views = offered(&client);
    assert!(
        views.len() == 2 && drops(&views[1], "old", "p2"),
        "the reading under the view the runner kept did not count: {views:?}"
    );
}

/// A view that goes out as a ride's answer is accepted with it, and a
/// reading under the view before it is stale. When the answer never reaches
/// the runner, ck-mc rolls the view back, and the same reading counts.
#[tokio::test]
async fn stale_accepted_a_ride_view_counts_until_its_answer_is_lost() {
    for lost in [false, true] {
        let (mut session, client, settings, eighteen) = under_view_eighteen().await;
        let mut ride = RideRequest::new(
            vec![RideCause::SurfaceChange],
            1_000,
            session.conditions.clone(),
        );
        ride.applied_view = Some(eighteen.applied());
        let answer = session
            .ride(&settings, &ride)
            .expect("a surface change lands the queued drop");
        assert!(drops(&answer, "old", "p2"), "{answer:?}");
        if lost {
            session.ride_undelivered(answer.version);
        }
        let request = reading(&session, &client, 2, HIGH, 18, &eighteen);
        session.notice(&client, &settings, request).await;
        assert_eq!(session.reading_stale, !lost, "lost: {lost}");
        let views = offered(&client);
        if lost {
            assert!(
                views.len() == 1 && drops(&views[0], "old", "p2"),
                "the drop the lost answer carried did not land: {views:?}"
            );
        } else {
            assert!(views.is_empty(), "{views:?}");
        }
    }
}

/// Until the runner renders the view it accepted, it may send more than one
/// reading under the view before it (its notices trail its requests). None
/// of them is a fault, so none makes ck-mc stop trusting the views it
/// names. Once the runner applies the accepted view, a different reading
/// under an older view is the fault the check is for, as before.
#[tokio::test]
async fn stale_accepted_readings_before_the_runner_renders_the_view_are_no_fault() {
    let (logs, _logging) = capture();
    let (mut session, client, settings, eighteen) = under_view_eighteen().await;
    let nineteen = hand_over(&mut session, &client).await;
    for (seq, prompt) in [(2, HIGH), (3, HIGH + 1_000), (4, HIGH + 2_000)] {
        let request = reading(&session, &client, seq, prompt, 18, &eighteen);
        session.notice(&client, &settings, request).await;
        assert!(session.reading_stale, "{prompt}");
        assert!(!session.prompt_views_untrusted, "{prompt}");
    }

    // The runner applies view 19; its notice still carries the newest
    // reading under view 18, now older than the view it applies.
    let request = reading(&session, &client, 5, HIGH + 2_000, 18, &nineteen);
    session.notice(&client, &settings, request).await;
    assert!(session.reading_stale);
    assert!(!session.prompt_views_untrusted);
    assert_eq!(offered(&client), vec![nineteen.clone()]);
    assert!(!logs.text().contains("a second stale reading"));

    // Control: a different reading under view 18 while the runner applies
    // view 19 still shows the runner at fault.
    let request = reading(&session, &client, 6, HIGH + 3_000, 18, &nineteen);
    session.notice(&client, &settings, request).await;
    assert!(session.prompt_views_untrusted);
    assert!(!session.reading_stale);
    assert_eq!(logs.text().matches("a second stale reading").count(), 1);
}

/// Setup again for the session, with the runner reporting `applied`.
async fn set_up_again(session: &mut Session, client: &Client, settings: &Settings, applied: &View) {
    let (_, _, route, request, _) = fixture();
    let mut setup = request;
    setup.applied_view = Some(applied.applied());
    setup.newest = client.entries.lock().unwrap().last().map(cursor);
    let features = session.features;
    session
        .setup(client, settings, &route, &setup, features)
        .await;
}

/// The runner's answer to `session.apply_view`: a refusal, or an
/// acceptance when `None`.
fn answer_with(client: &Client, refusal: Option<ViewRefusal>) {
    *client.refuse.lock().unwrap() = refusal.is_some();
    *client.refusal.lock().unwrap() = refusal;
}

/// A runner that sets up again (it reconnected, or restarted) while view 19
/// is accepted but not applied gets the view offered again, and its answer
/// decides whether it counts. One that still holds it refuses it as not
/// newer, and one that lost it accepts it again: either way its next request
/// carries view 19, so a reading under view 18 is stale. One that refuses it
/// for another reason never carries it, and the same reading counts.
#[tokio::test]
async fn stale_accepted_setup_offers_the_view_again_and_the_answer_decides() {
    let still_held = ViewRefusal::StaleVersion {
        version: 19,
        latest: 19,
    };
    for (answer, stale) in [
        (Some(still_held), true),
        (None, true),
        (Some(ViewRefusal::BadSince), false),
    ] {
        let (mut session, client, settings, eighteen) = under_view_eighteen().await;
        let nineteen = hand_over(&mut session, &client).await;
        answer_with(&client, answer.clone());
        set_up_again(&mut session, &client, &settings, &eighteen).await;
        assert_eq!(
            offered(&client),
            vec![nineteen.clone(), nineteen.clone()],
            "{answer:?}"
        );
        answer_with(&client, None);
        let request = reading(&session, &client, 1, HIGH, 18, &eighteen);
        session.notice(&client, &settings, request).await;
        assert_eq!(session.reading_stale, stale, "{answer:?}");
        let views = offered(&client);
        if stale {
            assert_eq!(views.len(), 2, "{answer:?}: {views:?}");
        } else {
            assert!(
                views.len() == 3 && drops(&views[2], "old", "p2"),
                "{answer:?}: {views:?}"
            );
        }
    }
}

/// After ck-mc restarts it can't tell whether the runner still holds a view
/// it accepted before: a ride's answer is saved just before it goes out and
/// may never have arrived. Restored without Setup, as a tool call before the
/// runner's next Setup restores a session, the view doesn't count, and a
/// reading under the view the runner applies is current. Once Setup offers
/// the view again and the runner says it holds it, it counts again.
#[tokio::test]
async fn stale_accepted_after_a_restart_the_view_counts_again_only_after_setup() {
    for (through_store, set_up) in [(false, false), (true, false), (true, true)] {
        let case = format!("saved: {through_store}, set up: {set_up}");
        let (mut session, client, settings, eighteen) = under_view_eighteen().await;
        hand_over(&mut session, &client).await;
        let durable = if through_store {
            // Saved and loaded as text, as the store does.
            let saved = serde_json::to_string(&session.durable()).unwrap();
            serde_json::from_str(&saved).unwrap()
        } else {
            session.durable()
        };
        let (mut restored, _, _, _, _) = fixture();
        restored.restore(durable);
        assert_eq!(restored.unconfirmed.len(), 1, "{case}");
        if set_up {
            answer_with(
                &client,
                Some(ViewRefusal::StaleVersion {
                    version: 19,
                    latest: 19,
                }),
            );
            set_up_again(&mut restored, &client, &settings, &eighteen).await;
            answer_with(&client, None);
        }
        let request = reading(&restored, &client, 1, HIGH, 18, &eighteen);
        restored.notice(&client, &settings, request).await;
        assert_eq!(restored.reading_stale, set_up, "{case}");
    }
}

/// The connection to the runner drops while ck-mc hands a view over: the
/// call fails, ck-mc rolls the view back, and it never counts.
#[tokio::test]
async fn stale_accepted_a_view_lost_with_the_connection_never_counts() {
    let (mut session, client, settings, eighteen) = under_view_eighteen().await;
    *client.fail_apply.lock().unwrap() = true;
    let view = session.seal_unchecked(Vec::new());
    session.publish(&client, view).await;
    assert!(session.unconfirmed.is_empty());
    *client.fail_apply.lock().unwrap() = false;
    let request = reading(&session, &client, 2, HIGH, 18, &eighteen);
    session.notice(&client, &settings, request).await;
    assert!(!session.reading_stale);
    let views = offered(&client);
    assert!(
        views.len() == 2 && drops(&views[1], "old", "p2"),
        "{views:?}"
    );
}

/// A runner whose state went back applies a view ck-mc doesn't expect, and
/// no longer holds the view it accepted: a reading under the view it now
/// applies counts on the notice that reports the change.
#[tokio::test]
async fn stale_accepted_a_runner_that_went_back_holds_nothing_it_accepted() {
    let (mut session, client, settings, _) = under_view_eighteen().await;
    hand_over(&mut session, &client).await;
    let older = View::seal(10, Vec::new());
    let mut answer = AppliedViewAnswer::new();
    answer.view = Some(older.clone());
    *client.applied.lock().unwrap() = Some(answer);
    let request = reading(&session, &client, 2, HIGH, 10, &older);
    session.notice(&client, &settings, request).await;
    assert_eq!(session.newest_applied, 10);
    assert!(
        !session.reading_stale,
        "a reading under the view the runner applies was judged stale"
    );
    assert!(
        session
            .unconfirmed
            .iter()
            .all(|pending| pending.view.version != 19),
        "ck-mc still expects the runner to show view 19"
    );
}
