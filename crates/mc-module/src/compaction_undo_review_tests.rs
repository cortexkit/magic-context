//! Review witnesses for the two passes that offer a view when the runner
//! lost ck-mc's view: Setup's (`Session::offer_at_setup`) and a notice's
//! (`Session::rebuild_when_runner_lost_view`). An offered view rewrites the
//! request bytes the provider has cached, so most tests check that no view
//! is offered while the runner still holds ck-mc's view. The others check
//! that a session whose host may hold a compaction marker gets one when it
//! needs one, and that forced views stop when the runner keeps refusing or
//! dropping them.
//!
//! The host compaction marker: when the runner applies a view, it writes
//! the host's own compaction marker at the view's cut, and the host stops
//! loading the messages before it. A session past that marker takes no step
//! until a view applies again, so it may send no notice. A session whose
//! runner never applied a view has no marker and keeps taking steps.
//!
//! The samples' conditions put usage near 13%, far below the execute
//! threshold, so a view offered on these notices is offered whatever the
//! usage.

use super::*;

/// The session saved to a store and loaded into a new session, as a ck-mc
/// restart does.
fn restarted(session: &Session, dir: &std::path::Path) -> Session {
    let store = Arc::new(crate::store::Store::open(&dir.join("mode3.db")).unwrap());
    store.save(&session.key, &session.durable()).unwrap();
    let (mut restored, _, _, _, _) = fixture();
    restored.db = session.db.clone();
    restored.set_store(Some(Arc::clone(&store)));
    restored.load_summaries();
    restored.restore(store.load(&session.key).unwrap());
    restored
}

/// The runner's `session.applied_view` answer names `applied`, or no view.
fn runner_applies(client: &Client, applied: Option<&View>) {
    let mut answer = AppliedViewAnswer::new();
    answer.view = applied.cloned();
    *client.applied.lock().unwrap() = Some(answer);
}

/// The runner's Setup for its transcript as the client holds it, applying
/// `applied`.
async fn set_up(
    session: &mut Session,
    client: &Client,
    settings: &Settings,
    applied: Option<&View>,
) {
    runner_applies(client, applied);
    let runner = client.entries.lock().unwrap().clone();
    let request = setup_request(runner.last().unwrap(), applied);
    let (_, _, route, _, _) = fixture();
    let features = session.features;
    session
        .setup(client, settings, &route, &request, features)
        .await;
}

/// A notice for the runner's transcript as the client holds it, the runner
/// applying `applied` (and naming it in its `session.applied_view` answer)
/// and reporting `events`.
async fn notice_applying(
    session: &mut Session,
    client: &Client,
    settings: &Settings,
    seq: u64,
    applied: Option<&View>,
    events: Vec<Event>,
) {
    runner_applies(client, applied);
    let newest = client.entries.lock().unwrap().last().map(cursor);
    let mut request = notice(session, seq, newest);
    request.applied_view = applied.map(View::applied);
    request.events = events;
    session.notice(client, settings, request).await;
}

fn offered_count(client: &Client) -> usize {
    client.offered.lock().unwrap().len()
}

/// Build view 3 on top of the runner's view 2: it drops a queued part of
/// message 20 (`msg_00000019`).
fn build_view_3(session: &mut Session, settings: &Settings) -> View {
    session.queued.insert((mid(20), "0".to_owned()));
    let (view, _) = session.build(settings, None, false, None);
    let view = view.expect("the queued drop makes a view");
    assert_eq!(view.version, 3);
    view
}

/// After a ck-mc restart ck-mc knows only the version of the view the runner
/// applies (`latest_unknown`). A Setup whose runner applies that view, and
/// a notice after it, offer nothing.
#[tokio::test]
async fn reoffer_review_a_restart_with_the_runner_on_the_current_view_offers_nothing() {
    let dir = scratch("reoffer-review-restart-current");
    let (session, client, settings) = view_2_applied(&dir, transcript()).await;
    let view_2 = session.latest.clone().unwrap();
    let mut restored = restarted(&session, &dir);
    assert!(restored.latest_unknown);
    assert_eq!(restored.newest_applied, 2);
    let before = offered_count(&client);
    set_up(&mut restored, &client, &settings, Some(&view_2)).await;
    assert_eq!(offered_count(&client), before, "Setup offered a view");
    assert_eq!(restored.latest.as_ref(), Some(&view_2));
    assert!(!restored.head_stale);
    notice_applying(&mut restored, &client, &settings, 1, Some(&view_2), vec![]).await;
    assert_eq!(offered_count(&client), before, "the notice offered a view");
    std::fs::remove_dir_all(dir).unwrap();
}

/// ck-mc handed view 3 over and restarted before the runner confirmed it.
/// The runner's Setup reports applying view 3: Setup confirms it and offers
/// nothing.
#[tokio::test]
async fn reoffer_review_a_restart_with_the_handed_view_applied_offers_nothing() {
    let dir = scratch("reoffer-review-restart-handed-applied");
    let (mut session, client, settings) = view_2_applied(&dir, transcript()).await;
    let view_3 = build_view_3(&mut session, &settings);
    assert!(session.publish(&client, view_3.clone()).await);
    let mut restored = restarted(&session, &dir);
    assert_eq!(
        restored.unconfirmed.len(),
        1,
        "view 3 was saved as handed over"
    );
    let before = offered_count(&client);
    set_up(&mut restored, &client, &settings, Some(&view_3)).await;
    assert_eq!(offered_count(&client), before, "Setup offered a view");
    assert!(restored.unconfirmed.is_empty(), "view 3 is confirmed");
    assert_eq!(restored.latest.as_ref(), Some(&view_3));
    std::fs::remove_dir_all(dir).unwrap();
}

/// ck-mc handed view 3 over, the runner accepted it but hasn't reached its
/// step boundary, and ck-mc restarted. The runner's Setup still reports view
/// 2. Setup offers view 3 again, as any Setup offers a view still waiting
/// for confirmation, and builds nothing new, whether the runner answers
/// that offer with an acceptance or with "not newer than view 3".
#[tokio::test]
async fn reoffer_review_a_restart_with_the_handed_view_pending_offers_only_that_view_again() {
    for already_held in [false, true] {
        let dir = scratch("reoffer-review-restart-handed-pending");
        let (mut session, client, settings) = view_2_applied(&dir, transcript()).await;
        let view_2 = session.latest.clone().unwrap();
        let view_3 = build_view_3(&mut session, &settings);
        assert!(session.publish(&client, view_3.clone()).await);
        let mut restored = restarted(&session, &dir);
        if already_held {
            *client.refuse.lock().unwrap() = true;
            *client.refusal.lock().unwrap() = Some(ViewRefusal::StaleVersion {
                version: 3,
                latest: 3,
            });
        }
        let before = offered_count(&client);
        set_up(&mut restored, &client, &settings, Some(&view_2)).await;
        let offered = offered_since(&client, before);
        assert_eq!(
            offered,
            std::slice::from_ref(&view_3),
            "already held {already_held}: Setup offered more than view 3 again"
        );
        assert_eq!(restored.latest.as_ref(), Some(&view_3));
        assert!(!restored.head_stale);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

/// The `session.apply_view` that handed view 3 over got no answer, so ck-mc
/// keeps it as possibly delivered, and then ck-mc restarted. Setup offers
/// view 3 again and builds nothing new: not when the runner takes that
/// offer, and not when that offer loses its answer too, which leaves the
/// view waiting for the next notice.
#[tokio::test]
async fn reoffer_review_a_restart_after_a_lost_apply_answer_offers_only_that_view_again() {
    for lose_again in [false, true] {
        let dir = scratch("reoffer-review-restart-lost-answer");
        let (mut session, client, settings) = view_2_applied(&dir, transcript()).await;
        let view_2 = session.latest.clone().unwrap();
        let view_3 = build_view_3(&mut session, &settings);
        *client.lose_apply_answers.lock().unwrap() = 1;
        assert!(session.publish(&client, view_3.clone()).await);
        assert!(session.unconfirmed[0].answer_lost);
        let mut restored = restarted(&session, &dir);
        if lose_again {
            *client.lose_apply_answers.lock().unwrap() = 1;
        }
        let before = offered_count(&client);
        set_up(&mut restored, &client, &settings, Some(&view_2)).await;
        assert_eq!(restored.reoffer_pending, lose_again);
        // The runner still applies view 2 on the next notice, before its
        // step boundary.
        notice_applying(&mut restored, &client, &settings, 1, Some(&view_2), vec![]).await;
        let offered = offered_since(&client, before);
        assert!(
            !offered.is_empty() && offered.iter().all(|view| *view == view_3),
            "lose again {lose_again}: offered {:?}",
            offered.iter().map(|view| view.version).collect::<Vec<_>>()
        );
        assert_eq!(restored.latest.as_ref(), Some(&view_3));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

/// The runner refused view 3 when it was handed over, so ck-mc rolled back
/// to view 2, which the runner applies. A runner Setup, before and after a
/// ck-mc restart, offers nothing.
#[tokio::test]
async fn reoffer_review_a_refused_and_rolled_back_view_offers_nothing_at_setup() {
    let dir = scratch("reoffer-review-refused-rolled-back");
    let (mut session, client, settings) = view_2_applied(&dir, transcript()).await;
    let view_2 = session.latest.clone().unwrap();
    let view_3 = build_view_3(&mut session, &settings);
    *client.refuse.lock().unwrap() = true;
    assert!(!session.publish(&client, view_3).await);
    *client.refuse.lock().unwrap() = false;
    assert_eq!(session.latest.as_ref(), Some(&view_2));
    assert!(session.version >= 3);
    let mut restored = restarted(&session, &dir);
    let before = offered_count(&client);
    set_up(&mut session, &client, &settings, Some(&view_2)).await;
    assert_eq!(offered_count(&client), before, "Setup offered a view");
    set_up(&mut restored, &client, &settings, Some(&view_2)).await;
    assert_eq!(
        offered_count(&client),
        before,
        "Setup after a restart offered a view"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// A ride's answer carried view 3 (`Session::ride` accepts the view and
/// records that the runner holds it). When the answer never reached the
/// runner, ck-mc rolls back to view 2, and a Setup applying view 2 offers
/// nothing, before or after a restart. When ck-mc doesn't learn that it
/// never arrived, Setup offers view 3 again and builds nothing new.
#[tokio::test]
async fn reoffer_review_a_ride_view_the_runner_never_got_offers_nothing_new_at_setup() {
    for undelivered in [true, false] {
        let dir = scratch("reoffer-review-ride");
        let (mut session, client, settings) = view_2_applied(&dir, transcript()).await;
        let view_2 = session.latest.clone().unwrap();
        let view_3 = build_view_3(&mut session, &settings);
        session.accept(view_3.clone());
        session.runner_holds(3);
        if undelivered {
            session.ride_undelivered(3);
            assert_eq!(session.latest.as_ref(), Some(&view_2));
        }
        let mut restored = restarted(&session, &dir);
        let before = offered_count(&client);
        set_up(&mut session, &client, &settings, Some(&view_2)).await;
        set_up(&mut restored, &client, &settings, Some(&view_2)).await;
        let offered = offered_since(&client, before);
        if undelivered {
            assert!(offered.is_empty(), "Setup offered {offered:?}");
        } else {
            assert_eq!(
                offered,
                [view_3.clone(), view_3.clone()],
                "each Setup offers view 3 again, and nothing else"
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}

/// A session with summaries that never had a view of ck-mc's applied: its
/// Setup, its first notice, and a notice after the runner refused ck-mc's
/// first view in the `session.apply_view` answer offer nothing.
#[tokio::test]
async fn reoffer_review_a_session_whose_runner_never_held_a_view_gets_no_offer() {
    let dir = scratch("reoffer-review-never-held");
    let (mut session, client, settings) = with_summaries(&dir);
    set_up(&mut session, &client, &settings, None).await;
    assert_eq!(offered_count(&client), 0, "Setup offered a view");
    notice_applying(&mut session, &client, &settings, 1, None, vec![]).await;
    assert_eq!(offered_count(&client), 0, "the first notice offered a view");
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the summaries are not shown yet");
    *client.refuse.lock().unwrap() = true;
    assert!(!session.publish(&client, view).await);
    *client.refuse.lock().unwrap() = false;
    notice_applying(&mut session, &client, &settings, 2, None, vec![]).await;
    assert_eq!(
        offered_count(&client),
        1,
        "the notice after the refused view 1 offered another view"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// The samples' session and summaries, through messages 10 and 18, with no
/// view built yet.
fn with_summaries(dir: &std::path::Path) -> (Session, Client, Settings) {
    let (mut session, client, _, _, settings) = fixture();
    session.conditions = sample(UNDO).conditions;
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    summary(&db, 1, 1, 10);
    summary(&db, 2, 11, 18);
    session.db = Some(Arc::new(db));
    session.features.summarizer = true;
    session.load_summaries();
    let runner = transcript();
    session.index.extend(runner.clone());
    *client.entries.lock().unwrap() = runner;
    (session, client, settings)
}

/// ck-mc's first view in a session, accepted and then refused at the
/// runner's step boundary. The runner never applied a view of ck-mc's, so
/// no host compaction marker was written and the session keeps taking
/// steps: the notice that reports the refusal shows no lost view, and at
/// this usage no rebuild is due.
#[tokio::test]
async fn reoffer_review_a_first_view_refused_at_its_step_boundary_is_not_a_lost_view() {
    let dir = scratch("reoffer-review-first-view-refused");
    let (mut session, client, settings) = with_summaries(&dir);
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the summaries are not shown yet");
    assert_eq!(view.version, 1);
    assert!(
        session.publish(&client, view).await,
        "the runner took view 1"
    );
    let before = offered_count(&client);
    let refused = Event::ViewRefused {
        version: 1,
        refusal: ViewRefusal::BadSince,
    };
    notice_applying(&mut session, &client, &settings, 1, None, vec![refused]).await;
    let offered = offered_since(&client, before);
    assert!(
        offered.is_empty(),
        "the notice offered view {:?} at {:?} prompt tokens though the runner never applied a view",
        offered.iter().map(|view| view.version).collect::<Vec<_>>(),
        session.conditions.last_prompt_tokens
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// The runner dropped view 2 and refuses, in its `session.apply_view`
/// answer, every view ck-mc offers, for a reason that names no part
/// (`bad_since`). `queued` is a drop queued before the first of those views.
async fn lost_and_always_refused(
    dir: &std::path::Path,
) -> (Session, Client, Settings, lanes::PartKey) {
    let (mut session, client, settings) = view_2_applied(dir, transcript()).await;
    let queued = (mid(20), "0".to_owned());
    session.queued.insert(queued.clone());
    *client.refuse.lock().unwrap() = true;
    (session, client, settings, queued)
}

/// The second-strike bound still holds for drops: a queued drop two refused
/// views carried is forgotten, and the views after that leave it out.
#[tokio::test]
async fn reoffer_review_a_drop_refused_twice_is_forgotten() {
    let dir = scratch("reoffer-review-refused-drop");
    let (mut session, client, settings, queued) = lost_and_always_refused(&dir).await;
    notice_applying(&mut session, &client, &settings, 1, None, vec![]).await;
    assert!(
        session.queued.contains(&queued),
        "one refusal keeps it queued"
    );
    assert!(session.refused_once.contains(&queued));
    notice_applying(&mut session, &client, &settings, 2, None, vec![]).await;
    assert!(
        !session.queued.contains(&queued),
        "a second refusal forgets it"
    );
    let before = offered_count(&client);
    notice_applying(&mut session, &client, &settings, 3, None, vec![]).await;
    let offered = offered_since(&client, before);
    assert!(offered.iter().all(|view| !names_part(view, &queued)));
    std::fs::remove_dir_all(dir).unwrap();
}

/// The forced view has its own bound: the runner refuses it on every notice
/// for a reason ck-mc can't fix, and after two such refusals with no new
/// message ck-mc stops building and offering it. A refused view never
/// renders, so the loop cost builds and calls, not the provider's cache.
#[tokio::test]
async fn reoffer_review_a_view_refused_on_every_offer_is_not_offered_on_every_notice() {
    let dir = scratch("reoffer-review-refused-loop");
    let (mut session, client, settings, _) = lost_and_always_refused(&dir).await;
    let before = offered_count(&client);
    for seq in 1..=5 {
        notice_applying(&mut session, &client, &settings, seq, None, vec![]).await;
    }
    let offered = offered_since(&client, before).len();
    assert!(
        offered <= 2,
        "{offered} views offered on 5 notices, each refused for the same reason"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// The runner applies each view ck-mc offers after it dropped one, then
/// drops that one too at its next step, with the transcript unchanged.
/// Every forced view the runner applies rewrites the request bytes the
/// provider cached, so after two such drops with no new message ck-mc stops
/// forcing views, and a view waits for usage to reach the execute threshold
/// or for a new summary.
#[tokio::test]
async fn reoffer_review_a_view_dropped_after_every_apply_is_not_offered_after_every_drop() {
    let dir = scratch("reoffer-review-drop-loop");
    let (mut session, client, settings) = view_2_applied(&dir, transcript()).await;
    let mut seq = 0;
    let mut forced = Vec::new();
    for _ in 0..3 {
        // The runner dropped the view it applied.
        seq += 1;
        let before = offered_count(&client);
        notice_applying(&mut session, &client, &settings, seq, None, vec![]).await;
        let Some(view) = offered_since(&client, before).pop() else {
            break;
        };
        forced.push(view.version);
        // Its next step applies the view offered.
        seq += 1;
        notice_applying(&mut session, &client, &settings, seq, Some(&view), vec![]).await;
        assert_eq!(session.newest_applied, view.version);
    }
    assert!(
        forced.len() <= 2,
        "forced views {forced:?} after 3 drops, each applied and so a cache rewrite"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// The runner dropped view 2 and refuses any view ck-mc offers on that
/// notice, so ck-mc holds no view of its own, and the session, past its
/// host's compaction marker, takes no step. At the runner's next Setup,
/// which still applies no view, ck-mc must offer one, or nothing will.
/// `restart` restores the session from its store first.
async fn setup_after_a_refused_forced_view(restart: bool) {
    let dir = scratch("reoffer-review-setup-after-refused");
    let (mut session, client, settings) = view_2_applied(&dir, transcript()).await;
    *client.refuse.lock().unwrap() = true;
    notice_applying(&mut session, &client, &settings, 1, None, vec![]).await;
    *client.refuse.lock().unwrap() = false;
    assert!(session.latest.is_none(), "ck-mc holds no view of its own");
    let mut session = if restart {
        restarted(&session, &dir)
    } else {
        session
    };
    let before = offered_count(&client);
    set_up(&mut session, &client, &settings, None).await;
    assert_eq!(
        offered_since(&client, before).len(),
        1,
        "restart {restart}: Setup offered no view to a runner that applies none, with the head due"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn reoffer_review_a_setup_after_a_refused_forced_view_offers_one() {
    setup_after_a_refused_forced_view(false).await;
}

#[tokio::test]
async fn reoffer_review_a_setup_after_a_restart_and_a_refused_forced_view_offers_one() {
    setup_after_a_refused_forced_view(true).await;
}

/// A session moved in: the move built its first view (view 1, cutting where
/// the summaries end) and saved the session's state, which the worker
/// restores at the session's first Setup.
fn moved_in(dir: &std::path::Path) -> (Session, Client, Settings, View) {
    let (mut session, client, settings) = with_summaries(dir);
    let view = session
        .first_view_after_move(&settings, Some((18, mid(18).as_str())))
        .unwrap();
    assert_eq!(cut_through(&view), Some(mid(18).as_str()));
    let restored = restarted(&session, dir);
    (restored, client, settings, view)
}

/// The runner's first Setup after the move reports the view the move
/// installed. Setup, and a notice after it, offer nothing.
#[tokio::test]
async fn reoffer_review_a_moved_session_with_its_view_installed_gets_no_offer() {
    let dir = scratch("reoffer-review-moved-installed");
    let (mut session, client, settings, view) = moved_in(&dir);
    set_up(&mut session, &client, &settings, Some(&view)).await;
    assert_eq!(offered_count(&client), 0, "Setup offered a view");
    assert_eq!(session.latest.as_ref(), Some(&view));
    notice_applying(&mut session, &client, &settings, 1, Some(&view), vec![]).await;
    assert_eq!(offered_count(&client), 0, "the notice offered a view");
    std::fs::remove_dir_all(dir).unwrap();
}

/// The runner's first Setup after the move applies no view: it lost the
/// one the move installed. A moved session takes no step until a view
/// applies, and installing the move's view left a possible host marker, so
/// Setup offers one.
#[tokio::test]
async fn reoffer_review_a_moved_session_without_its_view_gets_one_at_setup() {
    let dir = scratch("reoffer-review-moved-lost");
    let (mut session, client, settings, _) = moved_in(&dir);
    set_up(&mut session, &client, &settings, None).await;
    assert_eq!(
        offered_count(&client),
        1,
        "Setup offered no view to a moved session whose runner applies none"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lost_view_setup_replaces_the_head_when_readback_fails() {
    let dir = scratch("lost-view-setup-readback-failure");
    let (mut session, client, settings) = view_2_applied(&dir, transcript()).await;
    let before = offered_count(&client);
    *client.fail_applied_view.lock().unwrap() = true;
    set_up(&mut session, &client, &settings, None).await;
    let offered = offered_since(&client, before);
    assert_eq!(offered.len(), 1, "the runner cannot step without a head");
    assert_eq!(move_floor::cut_of(&offered[0]), Some(mid(18).as_str()));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn reoffered_view_remains_the_base_before_the_runner_can_apply_it() {
    for reoffer_on_setup in [true, false] {
        let dir = scratch("reoffered-view-is-the-base");
        let (mut session, client, settings) = view_2_applied(&dir, transcript()).await;
        let confirmed = session.latest.clone().unwrap();
        let pending = build_view_3(&mut session, &settings);
        if !reoffer_on_setup {
            *client.lose_apply_answers.lock().unwrap() = 1;
        }
        assert!(session.publish(&client, pending.clone()).await);
        let before = offered_count(&client);
        if reoffer_on_setup {
            set_up(&mut session, &client, &settings, None).await;
        } else {
            notice_applying(&mut session, &client, &settings, 1, None, vec![]).await;
        }
        assert_eq!(
            offered_since(&client, before),
            std::slice::from_ref(&pending)
        );
        assert_eq!(session.latest.as_ref(), Some(&pending));
        assert_eq!(session.unconfirmed.len(), 1);
        assert_eq!(session.newest_applied, 0);
        session.queued.insert((mid(21), "0".to_owned()));
        let request = RideRequest::new(
            vec![RideCause::EffortChange],
            1000,
            session.conditions.clone(),
        );
        let view = session
            .ride(&settings, &request)
            .expect("ride with a queued drop");
        assert!(view.edits.iter().any(|e| matches!(&e.op, EditOp::Drop { mid: id, .. } | EditOp::Replace { mid: id, .. } if id == &mid(20))));
        assert_eq!(move_floor::cut_of(&view), move_floor::cut_of(&confirmed));
        notice_applying(&mut session, &client, &settings, 2, None, vec![]).await;
        assert_eq!(session.latest.as_ref(), Some(&view));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn adopting_a_cut_restores_stamps_only_beyond_the_adopted_cut() {
    let dir = scratch("adoption-cut-covered-stamps");
    let (mut session, client, settings) = view_2_applied(&dir, transcript()).await;
    summary(session.db.as_ref().unwrap(), 3, 19, 21);
    session.load_summaries();
    session.summary_unshown = true;
    let key = |ordinal| (mid(ordinal), "0".to_owned());
    session.queued.extend([key(19), key(20)]);
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the new summary advances the cut");
    assert_eq!(move_floor::cut_of(&view), Some(mid(21).as_str()));
    assert!(session.publish(&client, view).await);
    assert!(session.queued.is_empty());
    let adopted = View::seal(
        1,
        vec![cortexkit_role_compaction::view::Edit::new(
            1,
            EditOp::Cut { through: mid(19) },
        )],
    );
    runner_applies(&client, Some(&adopted));
    session.adopt_runner_view(&client).await;
    assert_eq!(session.latest, Some(adopted));
    assert_eq!(session.queued, BTreeSet::from([key(20)]));
    assert!(session.index.find(&mid(20), "0").is_some());
    std::fs::remove_dir_all(dir).unwrap();
}
