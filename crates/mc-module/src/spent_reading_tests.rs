//! Readings that name no view and repeat the reading a view was built on.
//!
//! A runner that sends no `last_prompt_view` repeats its last measured prompt
//! size in every notice until it measures another request. Once a view is
//! built from that size, the repeats are the same measurement: no request
//! under the new view has been measured yet. They must build nothing more,
//! or the runner sends one request under each view and the provider writes
//! the cache twice. A different size is a new measurement and counts.

use super::*;

/// At the execute threshold (64,350 of the fixture's 99,000 usable tokens),
/// below the force band (84,150).
const READING: u64 = 70_000;
/// Another measurement above the threshold.
const NEXT_READING: u64 = 72_500;

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

/// A worker with two large old outputs (`old`/`p`, `old`/`p2`), three in the
/// middle (`mid`/`m1` to `m3`) and three in its newest step, whose runner
/// holds the same transcript, and the model's drop of `old`/`p2` queued.
fn worker() -> (Session, Client, Settings) {
    let (mut session, client, _, _, settings) = fixture();
    let entries = vec![
        text(1, "task"),
        tools(2, "old", &[("p", 10), ("p2", 11)]),
        text(3, "next"),
        tools(4, "mid", &[("m1", 12), ("m2", 13), ("m3", 14)]),
        text(5, "more"),
        tools(6, "newer", &[("q", 15), ("r", 16), ("s", 17)]),
        text(7, "go on"),
    ];
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries;
    session.index_ready = true;
    session.queued.insert(("old".into(), "p2".into()));
    (session, client, settings)
}

/// A notice whose conditions carry a reading of `prompt` tokens and name no
/// view, while the runner reports applying `applied`.
fn reading(
    session: &Session,
    client: &Client,
    seq: u64,
    prompt: u64,
    applied: Option<&View>,
) -> NoticeRequest {
    let newest = client.entries.lock().unwrap().last().map(cursor);
    let mut request = notice(session, seq, newest);
    request.conditions.last_prompt_tokens = Some(prompt);
    request.conditions.last_prompt_view = None;
    request.applied_view = applied.map(View::applied);
    request
}

/// The runner writes one more entry; the next notice reports it.
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

/// Let every log call see the subscriber `capture` installed. Tests run in
/// parallel, and `tracing` keeps one answer per call site to whether any
/// subscriber wants it: a call site another test reaches first while this
/// subscriber is being installed can keep the answer "none does" until
/// the answers are worked out again, as they are here.
fn refresh_log_interest() {
    tracing::callsite::rebuild_interest_cache();
}

/// The line logged when a repeat of the reading view `view` was built on is
/// ignored.
fn ignored_line(view: u64) -> String {
    format!("ignoring a prompt of {READING} tokens: view {view} was built on this same reading")
}

/// The first notice at the threshold builds a view from its reading, and the
/// runner accepts it.
async fn built_on_the_reading(session: &mut Session, client: &Client, settings: &Settings) -> View {
    let request = reading(session, client, 1, READING, None);
    session.notice(client, settings, request).await;
    let views = offered(client);
    assert_eq!(
        views.len(),
        1,
        "the first reading at the threshold built no view"
    );
    assert!(drops(&views[0], "old", "p2"), "{views:?}");
    assert_eq!(
        session.spent_reading,
        Some(SpentReading {
            tokens: READING,
            view: views[0].version,
            ignored: false,
        })
    );
    views[0].clone()
}

/// The order seen on a live runner that names no view in its readings: a
/// notice at the threshold builds a view, and the runner accepts it; the
/// next notice, before the runner sent a request under that view, carries
/// the same reading. It builds nothing, though the model queued another
/// drop, and says so once in the log. A notice with a different reading
/// above the threshold builds again. The runner reports the accepted view
/// still pending, or already applied, in the repeated notice.
#[tokio::test]
async fn spent_a_repeat_of_the_reading_a_view_was_built_on_builds_nothing() {
    for applied in [false, true] {
        let (logs, _logging) = capture();
        let (mut session, client, settings) = worker();
        let first = built_on_the_reading(&mut session, &client, &settings).await;
        let shown = applied.then_some(&first);
        refresh_log_interest();

        session.queued.insert(("mid".into(), "m1".into()));
        let request = reading(&session, &client, 2, READING, shown);
        session.notice(&client, &settings, request).await;
        assert_eq!(
            offered(&client),
            vec![first.clone()],
            "applied: {applied}: the repeated reading built a second view"
        );
        assert!(session.reading_stale, "applied: {applied}");
        assert!(session.queued.contains(&("mid".into(), "m1".into())));
        assert_eq!(session.conditions.last_prompt_tokens, Some(READING));
        assert_eq!(
            logs.text().matches(&ignored_line(first.version)).count(),
            1,
            "applied: {applied}: {}",
            logs.text()
        );
        let line = logs
            .text()
            .lines()
            .find(|line| line.contains(&ignored_line(first.version)))
            .map(str::to_owned);
        assert!(
            line.as_deref().is_some_and(|line| line.contains("INFO")),
            "{line:?}"
        );

        let request = reading(&session, &client, 3, NEXT_READING, shown);
        session.notice(&client, &settings, request).await;
        assert!(!session.reading_stale, "applied: {applied}");
        let views = offered(&client);
        assert!(
            views.len() == 2 && drops(&views[1], "mid", "m1"),
            "applied: {applied}: a new reading above the threshold built nothing: {views:?}"
        );
    }
}

/// The order seen on a live worker: after the view built on the reading,
/// the runner writes its step's entries, each with a notice that repeats
/// the reading, while the model queues more drops. None of them builds
/// another view, and the line is logged once for the view. The first
/// different reading lands every drop queued meanwhile in one view.
#[tokio::test]
async fn spent_repeats_with_new_entries_and_queued_drops_build_nothing() {
    let (logs, _logging) = capture();
    let (mut session, client, settings) = worker();
    let first = built_on_the_reading(&mut session, &client, &settings).await;
    refresh_log_interest();
    for (seq, part) in [(2, "m1"), (3, "m2"), (4, "m3")] {
        grow(&client, seq + 6);
        session.queued.insert(("mid".into(), part.into()));
        let request = reading(&session, &client, seq, READING, None);
        session.notice(&client, &settings, request).await;
        assert!(session.reading_stale, "notice {seq}");
        assert_eq!(offered(&client), vec![first.clone()], "notice {seq}");
    }
    assert_eq!(
        logs.text().matches(&ignored_line(first.version)).count(),
        1,
        "{}",
        logs.text()
    );

    let request = reading(&session, &client, 5, NEXT_READING, None);
    session.notice(&client, &settings, request).await;
    let views = offered(&client);
    assert_eq!(views.len(), 2, "{views:?}");
    for part in ["m1", "m2", "m3"] {
        assert!(drops(&views[1], "mid", part), "{part}: {views:?}");
    }
}

/// A view the runner refuses gives its reading back: the next notice with
/// the same reading builds a view again. The runner refuses it at its step
/// boundary (an event in that notice), or in its answer to
/// `session.apply_view`.
#[tokio::test]
async fn spent_a_refused_view_gives_its_reading_back() {
    let (mut session, client, settings) = worker();
    let first = built_on_the_reading(&mut session, &client, &settings).await;
    let mut request = reading(&session, &client, 2, READING, None);
    request.events.push(Event::ViewRefused {
        version: first.version,
        refusal: ViewRefusal::BadSince,
    });
    session.notice(&client, &settings, request).await;
    assert!(!session.reading_stale);
    let views = offered(&client);
    assert!(
        views.len() == 2 && drops(&views[1], "old", "p2"),
        "the reading of the refused view did not count again: {views:?}"
    );

    let (mut session, client, settings) = worker();
    *client.refuse.lock().unwrap() = true;
    let request = reading(&session, &client, 1, READING, None);
    session.notice(&client, &settings, request).await;
    assert_eq!(offered(&client).len(), 1);
    assert_eq!(session.spent_reading, None);
    *client.refuse.lock().unwrap() = false;
    let request = reading(&session, &client, 2, READING, None);
    session.notice(&client, &settings, request).await;
    assert!(!session.reading_stale);
    let views = offered(&client);
    assert!(
        views.len() == 2 && drops(&views[1], "old", "p2"),
        "the reading of the refused view did not count again: {views:?}"
    );
}

/// Setup again for `session`, with the runner reporting `applied`.
async fn set_up_again(
    session: &mut Session,
    client: &Client,
    settings: &Settings,
    applied: Option<&View>,
) {
    let (_, _, route, request, _) = fixture();
    let mut setup = request;
    setup.applied_view = applied.map(View::applied);
    setup.newest = client.entries.lock().unwrap().last().map(cursor);
    let features = session.features;
    session
        .setup(client, settings, &route, &setup, features)
        .await;
}

/// The view the runner reports applying when ck-mc reads it back.
fn runner_applies(client: &Client, view: Option<&View>) {
    let mut answer = AppliedViewAnswer::new();
    answer.view = view.cloned();
    *client.applied.lock().unwrap() = Some(answer);
}

/// ck-mc restarts between the view and the repeated reading. The state is
/// saved to and loaded from the store, and the runner sets the session up
/// again: it applies the view by then, or still holds it accepted, and
/// says so when Setup offers it again. The repeated reading is still
/// ignored, though the model queued another drop.
#[tokio::test]
async fn spent_the_reading_stays_spent_across_a_restart() {
    for applied in [false, true] {
        let (mut session, client, settings) = worker();
        let first = built_on_the_reading(&mut session, &client, &settings).await;
        let shown = applied.then_some(&first);
        if applied {
            // The runner applies the view, and its notice still carries
            // the reading the view was built on.
            let request = reading(&session, &client, 2, READING, shown);
            session.notice(&client, &settings, request).await;
            assert!(session.unconfirmed.is_empty());
        }
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
        store.save(session.key(), &session.durable()).unwrap();
        let saved = store.load(session.key()).expect("the saved state");

        let (mut restored, _, _, _, _) = fixture();
        restored.restore(saved);
        assert_eq!(restored.spent_reading, session.spent_reading);
        runner_applies(&client, shown);
        if !applied {
            // Setup offers the unconfirmed view again; a runner that holds
            // it refuses it as not newer.
            *client.refuse.lock().unwrap() = true;
            *client.refusal.lock().unwrap() = Some(ViewRefusal::StaleVersion {
                version: first.version,
                latest: first.version,
            });
        }
        set_up_again(&mut restored, &client, &settings, shown).await;
        *client.refuse.lock().unwrap() = false;
        let built = offered(&client).len();

        restored.queued.insert(("mid".into(), "m1".into()));
        let request = reading(&restored, &client, 1, READING, shown);
        restored.notice(&client, &settings, request).await;
        assert!(restored.reading_stale, "applied: {applied}");
        assert_eq!(
            offered(&client).len(),
            built,
            "applied: {applied}: a restart made the repeated reading count"
        );
    }
}

/// A Setup after which the runner applies no view ck-mc built (it lost its
/// state) forgets the spent reading: the same reading counts again.
#[tokio::test]
async fn spent_a_setup_without_the_view_gives_its_reading_back() {
    let (mut session, client, settings) = worker();
    let first = built_on_the_reading(&mut session, &client, &settings).await;
    let request = reading(&session, &client, 2, READING, Some(&first));
    session.notice(&client, &settings, request).await;
    assert!(session.reading_stale);

    runner_applies(&client, None);
    set_up_again(&mut session, &client, &settings, None).await;
    assert_eq!(session.spent_reading, None);
    session.queued.insert(("mid".into(), "m1".into()));
    let request = reading(&session, &client, 1, READING, None);
    session.notice(&client, &settings, request).await;
    assert!(!session.reading_stale);
    let views = offered(&client);
    assert!(
        views.len() == 2 && drops(&views[1], "mid", "m1"),
        "{views:?}"
    );
}

/// A runner that replaces ck-mc's view with one ck-mc doesn't expect
/// measures under that view: the repeated reading counts, and the spent
/// reading goes with the replaced view.
#[tokio::test]
async fn spent_a_view_the_runner_replaced_gives_its_reading_back() {
    let (mut session, client, settings) = worker();
    built_on_the_reading(&mut session, &client, &settings).await;
    let other = View::seal(7, Vec::new());
    runner_applies(&client, Some(&other));
    session.queued.insert(("mid".into(), "m1".into()));
    let request = reading(&session, &client, 2, READING, Some(&other));
    session.notice(&client, &settings, request).await;
    assert!(!session.reading_stale);
    let views = offered(&client);
    assert!(
        views.len() == 2 && drops(&views[1], "mid", "m1"),
        "{views:?}"
    );
}

/// A ride that says the request will not fit, or that its prefix changes
/// anyway, is the runner's own statement: it still builds a view on the
/// repeated reading, and that view carries the spent reading forward, so a
/// later repeat still builds nothing. Control: a ride that only says the
/// provider forgot its cache asks the reading, and gets no permission.
#[tokio::test]
async fn spent_rides_that_must_rewrite_still_land_on_the_repeated_reading() {
    for causes in [vec![RideCause::OverLimit], vec![RideCause::SurfaceChange]] {
        let (mut session, client, settings) = worker();
        built_on_the_reading(&mut session, &client, &settings).await;
        session.queued.insert(("mid".into(), "m1".into()));

        let mut conditions = session.conditions.clone();
        conditions.last_prompt_tokens = Some(READING);
        conditions.last_prompt_view = None;
        let forgotten = RideRequest::new(vec![RideCause::CacheExpired], 1_000, conditions.clone());
        assert_eq!(session.ride(&settings, &forgotten), None, "{causes:?}");
        assert!(session.reading_stale, "{causes:?}");

        let mut ride = RideRequest::new(causes.clone(), 1_000, conditions);
        if causes.contains(&RideCause::OverLimit) {
            ride = ride.with_request_tokens(100_000);
        }
        let view = session
            .ride(&settings, &ride)
            .unwrap_or_else(|| panic!("{causes:?} answered nothing"));
        assert!(session.reading_stale, "{causes:?}");
        assert!(drops(&view, "mid", "m1"), "{causes:?}: {view:?}");
        assert_eq!(
            session
                .spent_reading
                .map(|spent| (spent.tokens, spent.view)),
            Some((READING, view.version)),
            "{causes:?}"
        );

        session.queued.insert(("mid".into(), "m2".into()));
        let request = reading(&session, &client, 2, READING, None);
        session.notice(&client, &settings, request).await;
        assert!(session.reading_stale, "{causes:?}");
        assert_eq!(offered(&client).len(), 1, "{causes:?}");
    }
}

/// A runner that names the view each reading measured keeps the judgement
/// by view version alone: a reading under the newest view counts even when
/// its size equals the reading that view was built on.
#[tokio::test]
async fn spent_a_reading_that_names_its_view_is_judged_by_the_version_only() {
    let (mut session, client, settings) = worker();
    let mut request = reading(&session, &client, 1, READING, None);
    request.conditions.last_prompt_view = Some(0);
    session.notice(&client, &settings, request).await;
    let first = offered(&client)
        .last()
        .cloned()
        .expect("a reading at the threshold builds a view");

    session.queued.insert(("mid".into(), "m1".into()));
    let mut request = reading(&session, &client, 2, READING, Some(&first));
    request.conditions.last_prompt_view = Some(first.version);
    session.notice(&client, &settings, request).await;
    assert!(!session.reading_stale);
    let views = offered(&client);
    assert!(
        views.len() == 2 && drops(&views[1], "mid", "m1"),
        "a reading under the newest view was ignored for its size: {views:?}"
    );
}

/// Saved state from before the spent reading existed loads, with none; a
/// session without one saves no field for it, in its state or in its
/// unconfirmed views, so those rows don't change.
#[tokio::test]
async fn spent_saved_state_without_the_field_loads() {
    let (session, _, _) = worker();
    let text = serde_json::to_string(&session.durable()).unwrap();
    assert!(!text.contains("spent_reading"), "{text}");

    let (mut session, client, settings) = worker();
    built_on_the_reading(&mut session, &client, &settings).await;
    session.queued.insert(("mid".into(), "m1".into()));
    let request = reading(&session, &client, 2, NEXT_READING, None);
    session.notice(&client, &settings, request).await;
    assert_eq!(session.unconfirmed.len(), 2);
    let mut saved = serde_json::to_value(session.durable()).unwrap();
    let fields = saved.as_object_mut().unwrap();
    assert!(fields.remove("spent_reading").is_some());
    for pending in fields["unconfirmed"].as_array_mut().unwrap() {
        pending["before"]
            .as_object_mut()
            .unwrap()
            .remove("spent_reading");
    }
    let older: crate::store::Durable = serde_json::from_value(saved).unwrap();
    assert_eq!(older.spent_reading, None);
    let (mut restored, _, _, _, _) = fixture();
    restored.restore(older);
    assert_eq!(restored.spent_reading, None);
    assert_eq!(restored.unconfirmed.len(), 2);
    assert!(restored
        .unconfirmed
        .iter()
        .all(|pending| pending.before.spent_reading.is_none()));
}
