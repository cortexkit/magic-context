//! Statement order: a notice or ride whose `statement_seq` stamp is below
//! the highest one ck-mc took for the session was built from older runner
//! state, though it arrived later (a background notice overtaken by a ride).
//! ck-mc keeps the runner state it holds, and still reads the statement's
//! prompt size, entries and events.

use super::signed_floor_tests::{
    bound_notice, bound_set_up, bound_transcript, carries_requested, keeps_thought,
};
use super::*;
use cortexkit_role_compaction::tokens::SurfaceTokens;
use cortexkit_role_compaction::SignedFloor;

/// In the force band (85% or more of the usable window, where queued work
/// lands at once) of the fixture's 99,000 usable tokens.
const FORCE: u64 = 90_000;

/// The statement epoch the tests' sessions hold. A runner that stamps its
/// statements marks them with the epoch of the Setup they were built under,
/// and ck-mc drops a stamped statement without one.
const EPOCH: &str = "test-epoch";

/// Give `session` the epoch its Setup would have named.
fn under_epoch(session: &mut Session) {
    session.statement_epoch = Some(EPOCH.into());
}

/// A ride with no cause, stamped `stamp` (none when `None`), on the
/// session's conditions as `edit` changes them, while the runner applies
/// `applied`.
fn ride(
    session: &Session,
    stamp: Option<u64>,
    applied: Option<&View>,
    edit: impl FnOnce(&mut Conditions),
) -> RideRequest {
    let mut conditions = session.conditions.clone();
    conditions.statement_epoch = session.statement_epoch.clone();
    conditions.statement_seq = stamp;
    edit(&mut conditions);
    let mut ride = RideRequest::new(Vec::new(), 1_000, conditions);
    ride.applied_view = applied.map(View::applied);
    ride
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

/// A worker with two large old outputs and three newer ones, whose runner
/// holds the same transcript, and the model's drop of `old`/`p2` queued.
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
    under_epoch(&mut session);
    (session, client, settings)
}

/// Hand the runner a view, which it takes; it applies it from its next step.
fn take_view(session: &mut Session) -> View {
    let view = session.seal_unchecked(Vec::new());
    session.accept(view.clone());
    session.runner_holds(view.version);
    view
}

/// A notice carrying a reading of `prompt` tokens, measured under view
/// `view`, while the runner applies `applied`.
fn reading(
    session: &Session,
    client: &Client,
    seq: u64,
    prompt: u64,
    view: u64,
    applied: Option<&View>,
) -> NoticeRequest {
    let newest = client.entries.lock().unwrap().last().map(cursor);
    let mut request = notice(session, seq, newest);
    request.conditions.last_prompt_tokens = Some(prompt);
    request.conditions.last_prompt_view = Some(view);
    request.applied_view = applied.map(View::applied);
    request
}

/// A ride built from newer session state names signed floor `floor` (the
/// entry at or before which the runner strips signed reasoning, so edits
/// before that reasoning no longer invalidate it); a background notice
/// built before the ride, naming an older floor or none, arrives after it.
/// The floor stays the ride's, and the next view keeps the signed
/// reasoning that floor covers.
#[tokio::test]
async fn order_a_late_notice_keeps_the_newer_signed_floor() {
    for older in [Some("task"), None] {
        let (mut session, client, _, _, settings) = bound_set_up(Some("floor")).await;
        under_epoch(&mut session);
        let newer = ride(&session, Some(9), None, |conditions| {
            conditions.signed_floor = Some(SignedFloor::new("floor"));
        });
        assert!(session.ride(&settings, &newer).is_none());
        let mut late = bound_notice(&session, 1, older);
        late.conditions.statement_seq = Some(7);
        session.notice(&client, &settings, late).await;
        assert_eq!(session.signed_floor.as_deref(), Some("floor"), "{older:?}");
        // The late notice's reading is not taken, so its pass built nothing.
        assert!(client.offered.lock().unwrap().is_empty(), "{older:?}");
        let (view, _) = session.build(&settings, None, false, None);
        let view = view.expect("the requested drops build a view");
        assert!(carries_requested(&view), "{older:?}: {view:?}");
        assert!(keeps_thought(&view), "{older:?}: {view:?}");
    }
}

/// The model, window, output reserve, rules and image acceptance a late
/// notice names are older runner state too: ck-mc keeps the ride's.
#[tokio::test]
async fn order_a_late_notice_keeps_the_newer_model_and_window() {
    let (mut session, client, _, _, settings) = fixture();
    under_epoch(&mut session);
    let older = session.conditions.clone();
    let newer = ride(&session, Some(9), None, |conditions| {
        conditions.model = ModelRef::new("test", "newer-model");
        conditions.context_window = 120_000;
        conditions.output_reserve = 2_000;
        conditions.rules = ProviderRules::new(SignedParts::Bound, EditCost::Suffix);
        conditions.accepts_images = Some(true);
    });
    let held = newer.conditions.clone();
    session.ride(&settings, &newer);
    let mut late = notice(&session, 1, None);
    late.conditions = older;
    late.conditions.statement_epoch = Some(EPOCH.into());
    late.conditions.statement_seq = Some(7);
    session.notice(&client, &settings, late).await;
    assert_eq!(session.conditions.model, held.model);
    assert_eq!(session.conditions.context_window, held.context_window);
    assert_eq!(session.conditions.output_reserve, held.output_reserve);
    assert_eq!(session.conditions.rules, held.rules);
    assert_eq!(session.conditions.accepts_images, held.accepts_images);
}

/// Rides carry no surface counts, so the newer counts come from a notice.
/// A notice built before it that arrives later leaves the system, tools
/// and notes counts as the newer one stated them.
#[tokio::test]
async fn order_a_late_notice_keeps_the_newer_surface_and_notes_counts() {
    let (mut session, client, _, _, settings) = fixture();
    under_epoch(&mut session);
    let counted = |session: &Session, seq: u64, stamp: u64, counts: [u64; 3]| {
        let mut request = notice(session, seq, None);
        let [system, tools, notes] = counts.map(|n| Some(SurfaceTokens::new(n, true)));
        request.conditions.statement_seq = Some(stamp);
        request.conditions.system_tokens = system;
        request.conditions.tools_tokens = tools;
        request.conditions.notes_tokens = notes;
        request.token_family = Some("family".into());
        request
    };
    let newer = counted(&session, 1, 9, [300, 120, 40]);
    session.notice(&client, &settings, newer).await;
    let surface = session.surface_tokens;
    let notes = session.notes.clone();
    assert_eq!(notes.pending, Some(SurfaceTokens::new(40, true)));
    let late = counted(&session, 2, 7, [200, 50, 25]);
    session.notice(&client, &settings, late).await;
    assert_eq!(session.surface_tokens, surface);
    assert_eq!(session.notes, notes);
}

/// A late notice names the view the runner applied when it was built: none,
/// or one the runner has since replaced. The runner applies a newer view
/// now (a ride said so) and has taken a newer one still, which it applies
/// from its next step. The late notice settles nothing: the applied version
/// does not go back, the accepted view stays with ck-mc, and the reading it
/// carries, measured under its older view, is not taken and builds nothing.
#[tokio::test]
async fn order_a_late_notice_naming_an_older_applied_view_changes_no_view() {
    for (older, read_back_fails) in [(0, false), (1, false), (0, true), (1, true)] {
        let case = format!("named view {older}, read-back fails {read_back_fails}");
        let (mut session, client, settings) = worker();
        let views: Vec<View> = (0..=older).map(|_| take_view(&mut session)).collect();
        let applied = views.last().expect("a view").clone();
        let newer = ride(&session, Some(9), Some(&applied), |_| {});
        assert!(session.ride(&settings, &newer).is_none(), "{case}");
        assert_eq!(session.newest_applied, applied.version, "{case}");
        let pending = take_view(&mut session);
        let mut answer = AppliedViewAnswer::new();
        answer.view = Some(applied.clone());
        *client.applied.lock().unwrap() = Some(answer);
        *client.fail_applied_view.lock().unwrap() = read_back_fails;
        let named = views.iter().find(|view| view.version == older);
        let mut late = reading(&session, &client, 1, FORCE, older, named);
        late.conditions.statement_seq = Some(7);
        session.notice(&client, &settings, late).await;
        assert_eq!(session.newest_applied, applied.version, "{case}");
        assert_eq!(
            session.latest.as_ref().map(|view| view.version),
            Some(pending.version),
            "{case}"
        );
        assert!(
            session
                .unconfirmed
                .iter()
                .any(|waiting| waiting.view.version == pending.version && waiting.accepted),
            "{case}: the accepted view is no longer waiting"
        );
        // The ride had no reading, and the late one is not taken.
        assert_eq!(reading_of(&session.conditions), (None, None), "{case}");
        assert!(
            client.offered.lock().unwrap().is_empty(),
            "{case}: the late reading built a view: {:?}",
            client.offered.lock().unwrap()
        );
    }
}

/// Everything a reading can change in a session, for comparing before and
/// after a statement: the reading ck-mc keeps and its judgement, the
/// bookkeeping behind that judgement, the views the runner holds, and the
/// pressure state.
fn reading_state(session: &Session) -> String {
    format!(
        "{:?}",
        (
            reading_of(&session.conditions),
            session.reading_stale,
            session.ignored_reading,
            session.prompt_views_untrusted,
            session.spent_reading,
            session.newest_applied,
            session
                .unconfirmed
                .iter()
                .map(|waiting| (waiting.view.version, waiting.accepted, waiting.excused))
                .collect::<Vec<_>>(),
            session.keep_requested,
            session.emergency_latched,
            session.floor_pending_for.clone(),
        )
    )
}

/// A statement stamped below the held stamp was built before the statement
/// that set it, so its reading is the same as the one ck-mc holds or older.
/// It changes nothing: not the reading ck-mc keeps, not the judgement of
/// it or the bookkeeping behind that, not the pressure state, and it builds
/// nothing. The ride names view 2 and a reading below the threshold; the
/// late notices name older views (or none) and larger readings, some of
/// which the staleness rules would count and some they would ignore, and
/// one carries no reading at all.
#[tokio::test]
async fn order_a_late_notices_reading_changes_nothing() {
    for (named, measured, prompt) in [
        (Some(1), Some(1), Some(FORCE)),
        (None, Some(0), Some(FORCE)),
        (Some(1), None, Some(FORCE)),
        (Some(2), Some(2), Some(FORCE)),
        (Some(1), None, None),
    ] {
        let case = format!("applied {named:?}, measured {measured:?}, prompt {prompt:?}");
        let (mut session, client, settings) = worker();
        let views = [take_view(&mut session), take_view(&mut session)];
        let newer = ride(&session, Some(9), Some(&views[1]), |conditions| {
            conditions.last_prompt_tokens = Some(30_000);
            conditions.last_prompt_view = Some(views[1].version);
        });
        assert!(session.ride(&settings, &newer).is_none(), "{case}");
        assert!(!session.reading_stale, "{case}: precondition");
        session.keep_requested = true;
        session.emergency_latched = true;
        let before = reading_state(&session);
        let newest = client.entries.lock().unwrap().last().map(cursor);
        let mut late = notice(&session, 1, newest);
        late.conditions.statement_seq = Some(7);
        late.conditions.last_prompt_tokens = prompt;
        late.conditions.last_prompt_view = measured;
        late.applied_view = named
            .and_then(|version| views.iter().find(|view| view.version == version))
            .map(View::applied);
        session.notice(&client, &settings, late).await;
        assert_eq!(reading_state(&session), before, "{case}");
        assert!(
            client.offered.lock().unwrap().is_empty(),
            "{case}: {:?}",
            client.offered.lock().unwrap()
        );
    }
}

/// Equal stamps describe the same runner state: each statement is taken,
/// and the later arrival wins, as without stamps.
#[tokio::test]
async fn order_equal_stamps_are_each_taken() {
    let (mut session, client, _, _, settings) = bound_set_up(Some("floor")).await;
    under_epoch(&mut session);
    let first = ride(&session, Some(9), None, |conditions| {
        conditions.signed_floor = Some(SignedFloor::new("floor"));
    });
    session.ride(&settings, &first);
    let mut second = notice(&session, 1, bound_transcript().last().map(cursor));
    second.conditions.statement_seq = Some(9);
    second.conditions.signed_floor = Some(SignedFloor::new("task"));
    session.notice(&client, &settings, second).await;
    assert_eq!(session.signed_floor.as_deref(), Some("task"));
    let third = ride(&session, Some(9), None, |conditions| {
        conditions.signed_floor = Some(SignedFloor::new("thought"));
    });
    session.ride(&settings, &third);
    assert_eq!(session.signed_floor.as_deref(), Some("thought"));
}

/// One of the crate's statement-order vectors, decoded as ck-mc's transport
/// decodes a request: its method and its parameters.
fn vector<T: serde::de::DeserializeOwned>(name: &str, body: &str) -> (String, T) {
    let (method, params) = cortexkit_role_compaction::wire::decode(body.as_bytes())
        .unwrap_or_else(|refusal| panic!("{name}: {refusal:?}"));
    let params = cortexkit_role_compaction::wire::params(params)
        .unwrap_or_else(|refusal| panic!("{name}: {refusal:?}"));
    (method, params)
}

/// The published vectors decode with their epochs and stamps, and ck-mc
/// takes them: a Setup's stamp as held, even lower after a restore; a
/// notice and a ride under the same epoch, stamped above it, each raise
/// the held stamp. After the restore's Setup, the old epoch's notice is
/// dropped and the new epoch's first notice is taken.
#[tokio::test]
async fn order_the_contract_vectors_decode_and_set_the_held_stamp() {
    const OLD: &str = "89abcdef0123456789abcdef01234567";
    const NEW: &str = "fedcba9876543210fedcba9876543210";
    let (method, setup): (_, SetupRequest) = vector(
        "setup",
        include_str!("../testdata/compaction-v2-statement-seq/setup-statement-seq-request.json"),
    );
    assert_eq!(
        (
            method.as_str(),
            setup.statement_epoch.as_deref(),
            setup.statement_seq
        ),
        ("compaction.setup", Some(OLD), Some(42))
    );
    let (method, restored): (_, SetupRequest) = vector(
        "restored setup",
        include_str!(
            "../testdata/compaction-v2-statement-seq/setup-statement-seq-restored-request.json"
        ),
    );
    assert_eq!(
        (
            method.as_str(),
            restored.statement_epoch.as_deref(),
            restored.statement_seq
        ),
        ("compaction.setup", Some(NEW), Some(7))
    );
    let (method, notice): (_, NoticeRequest) = vector(
        "notice",
        include_str!("../testdata/compaction-v2-statement-seq/notice-statement-seq-request.json"),
    );
    assert_eq!(
        (
            method.as_str(),
            notice.conditions.statement_epoch.as_deref(),
            notice.conditions.statement_seq
        ),
        ("compaction.notice", Some(OLD), Some(42))
    );
    let (method, ride): (_, RideRequest) = vector(
        "ride",
        include_str!("../testdata/compaction-v2-statement-seq/ride-statement-seq-request.json"),
    );
    assert_eq!(
        (
            method.as_str(),
            ride.conditions.statement_epoch.as_deref(),
            ride.conditions.statement_seq
        ),
        ("compaction.ride", Some(OLD), Some(42))
    );
    let (method, after_restore): (_, NoticeRequest) = vector(
        "restored notice",
        include_str!(
            "../testdata/compaction-v2-statement-seq/notice-statement-seq-restored-request.json"
        ),
    );
    assert_eq!(
        (
            method.as_str(),
            after_restore.seq,
            after_restore.conditions.statement_epoch.as_deref(),
            after_restore.conditions.statement_seq
        ),
        ("compaction.notice", 1, Some(NEW), Some(8))
    );
    assert!(epoch_admits(Some(OLD), &notice.conditions));
    assert!(epoch_admits(Some(OLD), &ride.conditions));
    assert!(!epoch_admits(Some(NEW), &notice.conditions));
    assert!(epoch_admits(Some(NEW), &after_restore.conditions));

    // The vectors' presets and transcripts are the contract's examples, so
    // their epochs and stamps go through this crate's own Setup. It is
    // stamped below the vectors' 42, so the notice and the ride each raise
    // the held stamp. (`epoch_the_contract_vectors_old_epoch_is_dropped_through_the_module`
    // checks the old epoch through `Module`.)
    let (mut session, client, route, request, settings) = fixture();
    let below = request.clone().with_statement_order(OLD, 40, true).unwrap();
    session
        .setup(&client, &settings, &route, &below, session.features)
        .await;
    assert_eq!(session.statement_seq, Some(40));
    session.notice(&client, &settings, notice.clone()).await;
    assert_eq!(session.statement_seq, Some(42));
    assert_eq!(session.signed_floor.as_deref(), Some("message-a"));
    session
        .setup(&client, &settings, &route, &below, session.features)
        .await;
    assert_eq!(session.statement_seq, Some(40));
    session.ride(&settings, &ride);
    assert_eq!(session.statement_seq, Some(42));
    let lower = request
        .with_statement_order(NEW, restored.statement_seq.unwrap(), true)
        .unwrap();
    session
        .setup(&client, &settings, &route, &lower, session.features)
        .await;
    assert_eq!(session.statement_seq, Some(7));
    // The old epoch's notice, queued behind the restore's Setup, is dropped
    // on the worker: it takes neither its stamp nor its notice number.
    session.notice(&client, &settings, notice).await;
    assert_eq!((session.statement_seq, session.seq), (Some(7), 0));
    session.notice(&client, &settings, after_restore).await;
    assert_eq!((session.statement_seq, session.seq), (Some(8), 1));
    // Neither the epoch nor the stamp reaches the saved state.
    let saved = serde_json::to_value(session.durable()).unwrap().to_string();
    assert!(!saved.contains("statement_"), "saved: {saved}");
}

/// A Setup states the session as it is now: its epoch and stamp replace the
/// held ones even when the stamp is lower (a runner restored from a
/// backup), so the next statement at that stamp is taken. A Setup with
/// neither clears both: unstamped statements are then taken in arrival
/// order, and a stamped one is dropped.
#[tokio::test]
async fn order_a_setup_sets_the_held_stamp_even_lower() {
    let (mut session, client, route, request, settings) = bound_set_up(None).await;
    let stamped = |session: &Session, seq: u64, stamp: Option<u64>, floor: &str| {
        let mut request = notice(session, seq, bound_transcript().last().map(cursor));
        request.conditions.statement_seq = stamp;
        request.conditions.signed_floor = Some(SignedFloor::new(floor));
        request
    };
    let setup = |epoch: &str, stamp: Option<u64>| match stamp {
        Some(stamp) => request
            .clone()
            .with_statement_order(epoch, stamp, true)
            .unwrap(),
        None => request.clone(),
    };
    session
        .setup(
            &client,
            &settings,
            &route,
            &setup(EPOCH, Some(42)),
            session.features,
        )
        .await;
    assert_eq!(session.statement_seq, Some(42));
    session
        .notice(&client, &settings, stamped(&session, 1, Some(50), "floor"))
        .await;
    assert_eq!(session.statement_seq, Some(50));
    assert_eq!(session.signed_floor.as_deref(), Some("floor"));
    // The runner restored the session from a backup, under a new epoch.
    session
        .setup(
            &client,
            &settings,
            &route,
            &setup("restored-epoch", Some(7)),
            session.features,
        )
        .await;
    assert_eq!(session.statement_seq, Some(7));
    session
        .notice(&client, &settings, stamped(&session, 1, Some(7), "thought"))
        .await;
    assert_eq!(session.signed_floor.as_deref(), Some("thought"));
    session
        .notice(&client, &settings, stamped(&session, 2, Some(6), "task"))
        .await;
    assert_eq!(session.signed_floor.as_deref(), Some("thought"));
    // A Setup with neither: statements are taken in arrival order again,
    // and a stamped one is a statement of no Setup ck-mc holds.
    session
        .setup(
            &client,
            &settings,
            &route,
            &setup(EPOCH, None),
            session.features,
        )
        .await;
    assert_eq!(
        (session.statement_seq, session.statement_epoch.clone()),
        (None, None)
    );
    session
        .notice(&client, &settings, stamped(&session, 1, None, "task"))
        .await;
    assert_eq!(session.signed_floor.as_deref(), Some("task"));
    assert_eq!(session.statement_seq, None);
    let mut foreign = stamped(&session, 2, Some(3), "thought");
    foreign.conditions.statement_epoch = Some(EPOCH.into());
    session.notice(&client, &settings, foreign).await;
    assert_eq!(session.signed_floor.as_deref(), Some("task"));
    assert_eq!((session.statement_seq, session.seq), (None, 1));
}

/// A statement without a stamp is taken in arrival order whatever the held
/// stamp, and leaves the held stamp as it was.
#[tokio::test]
async fn order_an_unstamped_statement_is_taken_in_arrival_order() {
    let (mut session, client, _, _, settings) = bound_set_up(Some("floor")).await;
    under_epoch(&mut session);
    let newer = ride(&session, Some(9), None, |conditions| {
        conditions.signed_floor = Some(SignedFloor::new("floor"));
    });
    session.ride(&settings, &newer);
    let mut unstamped = notice(&session, 1, bound_transcript().last().map(cursor));
    unstamped.conditions.statement_seq = None;
    unstamped.conditions.signed_floor = Some(SignedFloor::new("task"));
    session.notice(&client, &settings, unstamped).await;
    assert_eq!(session.signed_floor.as_deref(), Some("task"));
    assert_eq!(session.statement_seq, Some(9));
    let mut late = notice(&session, 2, bound_transcript().last().map(cursor));
    late.conditions.statement_seq = Some(8);
    late.conditions.signed_floor = Some(SignedFloor::new("thought"));
    session.notice(&client, &settings, late).await;
    assert_eq!(session.signed_floor.as_deref(), Some("task"));
    let unstamped = ride(&session, None, None, |conditions| {
        conditions.signed_floor = Some(SignedFloor::new("thought"));
    });
    session.ride(&settings, &unstamped);
    assert_eq!(session.signed_floor.as_deref(), Some("thought"));
    assert_eq!(session.statement_seq, Some(9));
}

/// Each late notice or ride is counted once (and logged once), for the
/// Setup that follows; equal, higher and unstamped statements are not, and
/// a Setup starts the count again.
#[tokio::test]
async fn order_each_late_statement_is_counted_once() {
    let (mut session, client, route, request, settings) = fixture();
    under_epoch(&mut session);
    let newer = ride(&session, Some(9), None, |_| {});
    let _ = session.ride(&settings, &newer);
    let mut late = notice(&session, 1, None);
    late.conditions.statement_seq = Some(7);
    session.notice(&client, &settings, late).await;
    assert_eq!(session.late_statements, 1);
    let late = ride(&session, Some(8), None, |_| {});
    let _ = session.ride(&settings, &late);
    assert_eq!(session.late_statements, 2);
    for (seq, stamp) in [(2, Some(9)), (3, Some(10)), (4, None)] {
        let mut taken = notice(&session, seq, None);
        taken.conditions.statement_seq = stamp;
        session.notice(&client, &settings, taken).await;
    }
    let unstamped = ride(&session, None, None, |_| {});
    let _ = session.ride(&settings, &unstamped);
    assert_eq!(session.late_statements, 2);
    session
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    assert_eq!(session.late_statements, 0);
}

/// A late ride is older runner state as a late notice is: its floor, model,
/// window and reading are not taken, and the ride says nothing about the
/// view the runner applies.
#[tokio::test]
async fn order_a_late_ride_keeps_the_newer_runner_state() {
    let (mut session, _, _, _, settings) = bound_set_up(Some("floor")).await;
    under_epoch(&mut session);
    let newer = ride(&session, Some(9), None, |conditions| {
        conditions.signed_floor = Some(SignedFloor::new("floor"));
        conditions.model = ModelRef::new("test", "newer-model");
        conditions.context_window = 120_000;
        conditions.last_prompt_tokens = Some(20_000);
        conditions.last_prompt_view = Some(0);
    });
    assert!(session.ride(&settings, &newer).is_none());
    let held = (session.conditions.clone(), session.signed_floor.clone());
    let before = reading_state(&session);
    let late = ride(&session, Some(8), None, |conditions| {
        conditions.signed_floor = Some(SignedFloor::new("task"));
        conditions.model = ModelRef::new("test", "model");
        conditions.context_window = 100_000;
        conditions.last_prompt_tokens = Some(FORCE);
        conditions.last_prompt_view = Some(0);
    });
    assert!(session.ride(&settings, &late).is_none());
    assert_eq!(
        (session.conditions.clone(), session.signed_floor.clone()),
        held
    );
    assert_eq!(reading_state(&session), before);
}

/// A ride's log line names the reading ck-mc took from it, and for a late
/// ride, whose reading is not taken, says so instead of naming that
/// reading.
#[tokio::test]
async fn order_a_late_rides_log_line_names_no_reading() {
    let (mut session, _, _, _, settings) = bound_set_up(Some("floor")).await;
    under_epoch(&mut session);
    let newer = ride(&session, Some(9), None, |conditions| {
        conditions.last_prompt_tokens = Some(20_000);
    });
    let (_, logged) = crate::test_log::logged(|| session.ride(&settings, &newer));
    assert!(logged.contains("last prompt Some(20000)"), "{logged}");
    let late = ride(&session, Some(8), None, |conditions| {
        conditions.last_prompt_tokens = Some(FORCE);
    });
    let (_, logged) = crate::test_log::logged(|| session.ride(&settings, &late));
    assert!(
        logged.contains("last prompt late, reading ignored"),
        "{logged}"
    );
    assert!(!logged.contains(&FORCE.to_string()), "{logged}");
}

/// A late notice still carries the transcript: a view the runner refused at
/// a step boundary is rolled back, though the notice's applied view (none,
/// from before the ride) is not taken.
#[tokio::test]
async fn order_a_late_notice_still_settles_a_refused_view() {
    let (mut session, client, settings) = worker();
    let applied = take_view(&mut session);
    let newer = ride(&session, Some(9), Some(&applied), |_| {});
    assert!(session.ride(&settings, &newer).is_none());
    let refused = take_view(&mut session);
    let mut late = notice(
        &session,
        1,
        client.entries.lock().unwrap().last().map(cursor),
    );
    late.conditions.statement_seq = Some(7);
    late.events.push(Event::ViewRefused {
        version: refused.version,
        refusal: ViewRefusal::BadSince,
    });
    session.notice(&client, &settings, late).await;
    assert!(
        session.unconfirmed.is_empty(),
        "the refused view is still waiting"
    );
    assert_eq!(
        session.latest.as_ref().map(|view| view.version),
        Some(applied.version)
    );
    assert_eq!(session.newest_applied, applied.version);
}

/// A late notice or ride for a session held because its transcript was
/// behind its summaries resumes the session as any statement does, but its
/// applied view is not taken there either: the applied version stays, and
/// the view the runner accepted stays waiting.
#[tokio::test]
async fn order_a_late_statement_resuming_a_held_session_changes_no_view() {
    for by_ride in [false, true] {
        let (mut session, client, settings) = worker();
        let applied = take_view(&mut session);
        let newer = ride(&session, Some(9), Some(&applied), |conditions| {
            conditions.model = ModelRef::new("test", "newer-model");
        });
        assert!(session.ride(&settings, &newer).is_none());
        let pending = take_view(&mut session);
        let held = session.conditions.clone();
        session.transcript_behind = Some(1);
        session.index_ready = false;
        if by_ride {
            let late = ride(&session, Some(8), None, |conditions| {
                conditions.model = ModelRef::new("test", "model");
                conditions.last_prompt_tokens = Some(FORCE);
                conditions.last_prompt_view = Some(0);
            });
            session.before_ride(&client, &late).await;
            let _ = session.ride(&settings, &late);
        } else {
            let newest = client.entries.lock().unwrap().last().map(cursor);
            let mut late = notice(&session, 1, newest);
            late.conditions.statement_seq = Some(7);
            late.conditions.model = ModelRef::new("test", "model");
            late.conditions.last_prompt_tokens = Some(FORCE);
            late.conditions.last_prompt_view = Some(0);
            session.notice(&client, &settings, late).await;
        }
        let case = if by_ride { "ride" } else { "notice" };
        assert!(session.transcript_behind.is_none(), "{case}: resumed");
        assert_eq!(session.newest_applied, applied.version, "{case}");
        assert_eq!(
            session.latest.as_ref().map(|view| view.version),
            Some(pending.version),
            "{case}"
        );
        assert!(
            session
                .unconfirmed
                .iter()
                .any(|waiting| waiting.view.version == pending.version),
            "{case}: the accepted view is no longer waiting"
        );
        assert_eq!(session.conditions, held, "{case}");
    }
}

/// The held stamp is memory only: the saved conditions never carry it, and
/// a restarted ck-mc takes the first stamped statement as the held stamp.
#[tokio::test]
async fn order_the_held_stamp_is_not_saved() {
    let (mut session, client, route, request, settings) = fixture();
    under_epoch(&mut session);
    let mut stamped = notice(&session, 1, None);
    stamped.conditions.statement_seq = Some(9);
    session.notice(&client, &settings, stamped).await;
    assert_eq!(session.statement_seq, Some(9));
    let saved = serde_json::to_value(session.durable()).unwrap();
    assert!(!saved.to_string().contains("statement_"), "saved: {saved}");
    let (mut restored, ..) = fixture();
    restored.restore(serde_json::from_value(saved).unwrap());
    assert_eq!(
        (restored.statement_seq, restored.statement_epoch.clone()),
        (None, None)
    );
    // A restarted ck-mc holds no epoch, so the runner's next statement is
    // dropped until it sets the session up again; its Setup then sets the
    // epoch and the held stamp.
    let mut early = notice(&restored, 1, None);
    early.conditions.statement_epoch = Some(EPOCH.into());
    early.conditions.statement_seq = Some(3);
    restored.notice(&client, &settings, early).await;
    assert_eq!((restored.statement_seq, restored.seq), (None, 0));
    let again = request.with_statement_order(EPOCH, 3, true).unwrap();
    restored
        .setup(&client, &settings, &route, &again, restored.features)
        .await;
    let mut first = notice(&restored, 1, None);
    first.conditions.statement_seq = Some(4);
    restored.notice(&client, &settings, first).await;
    assert_eq!(restored.statement_seq, Some(4));
}

/// Statements without an epoch or stamp, from a runner on 0.3.7, decode
/// to exactly what they were: the published 0.3.7 request bodies, decoded
/// with this crate's contract types and encoded again, are unchanged and
/// gain no statement-order member, and each is admitted for a session
/// whose Setup named no epoch.
#[test]
fn order_037_request_bodies_decode_unchanged() {
    fn body(name: &str) -> serde_json::Value {
        let base =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/compaction-0.3.7");
        let vector: serde_json::Value =
            serde_json::from_slice(&std::fs::read(base.join(name)).unwrap()).unwrap();
        vector["params"].clone()
    }
    fn round_trip<T: serde::de::DeserializeOwned + serde::Serialize>(
        params: &serde_json::Value,
    ) -> (T, serde_json::Value) {
        let decoded: T = serde_json::from_value(params.clone()).unwrap();
        let encoded = serde_json::to_value(&decoded).unwrap();
        (decoded, encoded)
    }
    for name in [
        "setup-limits-request.json",
        "setup-limits-legacy-request.json",
    ] {
        let params = body(name);
        let (setup, encoded) = round_trip::<SetupRequest>(&params);
        assert_eq!(encoded, params, "{name}");
        assert_eq!((setup.statement_epoch, setup.statement_seq), (None, None));
    }
    let params = body("notice-window-over-budget-request.json");
    let (notice, encoded) = round_trip::<NoticeRequest>(&params);
    assert_eq!(encoded, params);
    assert!(epoch_admits(None, &notice.conditions));
    let params = body("ride-window-over-budget-request.json");
    let (ride, encoded) = round_trip::<RideRequest>(&params);
    assert_eq!(encoded, params);
    assert!(epoch_admits(None, &ride.conditions));
    for encoded in [&notice.conditions, &ride.conditions] {
        let text = serde_json::to_string(encoded).unwrap();
        assert!(!text.contains("statement_"), "{text}");
    }
}
