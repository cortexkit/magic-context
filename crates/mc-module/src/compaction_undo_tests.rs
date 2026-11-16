//! Agent Runner's `compaction-undo-v1` bodies (`testdata/compaction-undo-v1`,
//! whose README describes the session behind them), driven through
//! `Session::notice`. When a view stops fitting the session's history, the
//! runner drops it and names it refused. A session past its host's
//! compaction marker, or moved in from another host, then takes no step
//! until a view applies, so ck-mc must offer a new view while it handles the
//! notice that says so, not on a later pressure reading or summary.

use super::*;

#[path = "compaction_undo_review_tests.rs"]
mod review_tests;

const UNDO: &[u8] = include_bytes!("../testdata/compaction-undo-v1/a-undo-notice.json");
const STALE_WINDOW: &[u8] =
    include_bytes!("../testdata/compaction-undo-v1/b-stale-window-notice.json");
const EDIT_BEFORE_CUT: &[u8] =
    include_bytes!("../testdata/compaction-undo-v1/c-apply-view-edit-before-cut.json");

/// A sample notice, decoded. Encoding it again gives the sample's own JSON,
/// so the session handles exactly the body the runner sent.
fn sample(bytes: &[u8]) -> NoticeRequest {
    let notice: NoticeRequest = serde_json::from_slice(bytes).unwrap();
    assert_eq!(
        serde_json::to_value(&notice).unwrap(),
        serde_json::from_slice::<Value>(bytes).unwrap(),
        "the sample decodes without losing anything"
    );
    notice
}

/// The runner's id for the message at `ordinal`: the samples' session counts
/// from `msg_00000000` at ordinal 1.
fn mid(ordinal: u64) -> String {
    format!("msg_{:08}", ordinal - 1)
}

/// The tag of the text part of the message at `ordinal`. Tags rise in
/// transcript order around the tags 23 and 24 that the undo notice's entry
/// (message 16) carries, with room for one more after each later message.
fn tag(ordinal: u64) -> u64 {
    if ordinal < 16 {
        ordinal
    } else {
        2 * ordinal - 8
    }
}

/// The sample session's 24 messages, a person's and the model's in turn.
/// Message 16 (`msg_00000015`) is the entry the undo notice carries; the
/// others are plain text. The newest has the digest the stale-window
/// notice names for it.
fn transcript() -> Vec<Entry> {
    let undo = sample(UNDO);
    let stale = sample(STALE_WINDOW);
    (1..=24u64)
        .map(|ordinal| {
            if let Some(kept) = undo.entries.iter().find(|entry| entry.ordinal == ordinal) {
                return kept.clone();
            }
            let role = if ordinal % 2 == 0 {
                Role::Assistant
            } else {
                Role::User
            };
            let mut entry = Entry::new(
                ordinal,
                mid(ordinal),
                role,
                999 + ordinal,
                vec![text_part("0", tag(ordinal), &format!("message {ordinal}"))],
            );
            if ordinal == 24 {
                entry.digest = stale.newest.clone().unwrap().digest;
            }
            entry
        })
        .collect()
}

fn text_part(id: &str, tag: u64, text: &str) -> Part {
    let mut part = Part::new(id, PartBody::Text { text: text.into() });
    part.tag = Some(tag);
    part
}

fn summary(db: &ContextDb, sequence: i64, start: u64, end: u64) {
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at, harness) VALUES ('s1', ?1, ?2, ?3, ?4, ?5, 'work', ?6, ?6, 1, 'mock')",
            rusqlite::params![
                sequence,
                start as i64,
                end as i64,
                mid(start),
                mid(end),
                format!("what happened through {}", mid(end))
            ],
        )
        .map_err(|error| error.to_string())
    })
    .unwrap();
}

fn cut_through(view: &View) -> Option<&str> {
    view.edits.iter().find_map(|edit| match &edit.op {
        EditOp::Cut { through } => Some(through.as_str()),
        _ => None,
    })
}

/// Whether an edit of `view` names the part `key`.
fn names_part(view: &View, (mid, part): &lanes::PartKey) -> bool {
    view.edits.iter().any(|edit| {
        let op = serde_json::to_value(&edit.op).unwrap();
        op["mid"] == mid.as_str() && op["part"] == part.as_str()
    })
}

/// The views offered since `before` of them were.
fn offered_since(client: &Client, before: usize) -> Vec<View> {
    client.offered.lock().unwrap()[before..].to_vec()
}

/// The session as the samples find it: summaries through messages 10 and 18
/// (`msg_00000009` and `msg_00000017`), and the runner applying ck-mc's
/// view 2, the history head and a cut through `msg_00000017`. `held` is
/// the transcript as ck-mc read it, and as the runner holds it until a test
/// changes the runner's copy.
async fn view_2_applied(dir: &std::path::Path, held: Vec<Entry>) -> (Session, Client, Settings) {
    let (mut session, client, _, _, settings) = fixture();
    session.conditions = sample(UNDO).conditions;
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    summary(&db, 1, 1, 10);
    summary(&db, 2, 11, 18);
    session.db = Some(Arc::new(db));
    session.features.summarizer = true;
    session.load_summaries();
    session.index.extend(held.clone());
    *client.entries.lock().unwrap() = held;
    // View 1 came before it.
    session.version = 1;
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the summaries are not shown yet");
    assert_eq!(view.version, 2);
    assert_eq!(cut_through(&view), Some(mid(18).as_str()));
    assert!(session.publish(&client, view.clone()).await);
    session.settle_unconfirmed(Some(&view.applied()), &[]);
    assert_eq!(session.cut, Some(18));
    (session, client, settings)
}

/// (a) An undo removed the cut's own message. The runner dropped view 2 and
/// its window, refuses the view by name, and reports the transcript changed
/// from message 16. ck-mc forgets the summary that ended on the removed
/// message and, on that same notice, offers a view cut where the remaining
/// summary ends, one the runner can apply to what the undo left.
#[tokio::test]
async fn compaction_undo_v1_an_undo_behind_the_cut_offers_a_view_on_its_notice() {
    let dir = scratch("undo-v1-a");
    let (mut session, client, settings) = view_2_applied(&dir, transcript()).await;
    // The undo removed every message from `msg_00000016` (message 17) on.
    client.entries.lock().unwrap().truncate(16);
    let before = client.offered.lock().unwrap().len();
    session.notice(&client, &settings, sample(UNDO)).await;
    assert_eq!(session.seq, 1, "the notice was taken");
    let offered = offered_since(&client, before);
    let [view] = &offered[..] else {
        panic!("{} views offered on the undo notice", offered.len());
    };
    assert_eq!(
        session
            .summaries
            .iter()
            .map(|summary| summary.end_message as u64)
            .collect::<Vec<_>>(),
        [10],
        "the summary through the removed message is forgotten"
    );
    assert_eq!(
        cut_through(view),
        Some(mid(10).as_str()),
        "the view cuts where the remaining summary ends"
    );
    let left = client.entries.lock().unwrap().clone();
    cortexkit_compaction_view::render::apply(&left, view)
        .expect("the runner can apply the view to what the undo left");
    assert_eq!(
        session.latest.as_ref().map(|latest| latest.version),
        Some(view.version)
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// ck-mc's copy of message 20 (`msg_00000019`) with a part `99` the runner's
/// copy doesn't have, so a view that drops it is refused as `unknown_part`.
fn with_part_99(runner: &Entry) -> Entry {
    let mut parts = runner.parts.clone();
    parts.push(text_part(
        "99",
        tag(20) + 1,
        "a part the runner does not have",
    ));
    Entry::new(
        runner.ordinal,
        runner.mid.clone(),
        runner.role.clone(),
        runner.written_at,
        parts,
    )
}

/// The state the stale-window notice finds: the runner dropped view 2 and
/// its window earlier, so it applies no view, and it took ck-mc's view 3,
/// which shows a new summary through `msg_00000018`, cuts there, and drops
/// part `99` of `msg_00000019`. Its step boundary has not come yet. Returns
/// the runner's transcript and the part view 3 drops.
async fn view_3_pending(
    dir: &std::path::Path,
) -> (Session, Client, Settings, Vec<Entry>, lanes::PartKey) {
    let runner = transcript();
    let mut held = runner.clone();
    held[19] = with_part_99(&runner[19]);
    let (mut session, client, settings) = view_2_applied(dir, held).await;
    session.adopt_runner_view(&client).await;
    assert!(session.latest.is_none(), "the runner applies no view");
    summary(session.db.as_deref().unwrap(), 3, 19, 19);
    session.load_summaries();
    session.summary_unshown = true;
    let part_99 = (mid(20), "99".to_owned());
    session.queued.insert(part_99.clone());
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the new summary and the queued drop make a view");
    assert_eq!(view.version, 3);
    assert_eq!(cut_through(&view), Some(mid(19).as_str()));
    assert!(names_part(&view, &part_99));
    assert!(
        session.publish(&client, view).await,
        "the runner took view 3"
    );
    *client.entries.lock().unwrap() = runner.clone();
    (session, client, settings, runner, part_99)
}

/// (b) A step found its window stale. The runner refuses ck-mc's pending
/// view 3 at the step boundary, naming the part it doesn't have; the history
/// didn't change. ck-mc offers, on that same notice, a view without that
/// part, cut where the summaries end, that the runner can apply.
#[tokio::test]
async fn compaction_undo_v1_a_stale_window_offers_a_view_on_its_notice() {
    let dir = scratch("undo-v1-b");
    let (mut session, client, settings, runner, part_99) = view_3_pending(&dir).await;
    let before = client.offered.lock().unwrap().len();
    session
        .notice(&client, &settings, sample(STALE_WINDOW))
        .await;
    assert_eq!(session.seq, 1, "the notice was taken");
    let offered = offered_since(&client, before);
    let [view] = &offered[..] else {
        panic!("{} views offered on the stale-window notice", offered.len());
    };
    assert!(
        !names_part(view, &part_99),
        "the view drops the refused part again: {:?}",
        view.edits
    );
    assert_eq!(cut_through(view), Some(mid(19).as_str()));
    cortexkit_compaction_view::render::apply(&runner, view)
        .expect("the runner can apply the view to its transcript");
    // The runner took the view and serves it from its next step boundary. A
    // notice before that boundary still names no applied view, and the view
    // waiting there is not offered again.
    let newest = runner.last().map(cursor);
    let pending = client.offered.lock().unwrap().len();
    session
        .notice(&client, &settings, notice(&session, 2, newest))
        .await;
    assert_eq!(client.offered.lock().unwrap().len(), pending);
    std::fs::remove_dir_all(dir).unwrap();
}

/// The view offered after the stale window, refused in its turn, stays due:
/// the next notice offers one again, whatever the usage.
#[tokio::test]
async fn compaction_undo_v1_a_refused_rebuild_stays_due() {
    let dir = scratch("undo-v1-b-refused");
    let (mut session, client, settings, runner, _) = view_3_pending(&dir).await;
    *client.refuse.lock().unwrap() = true;
    let before = client.offered.lock().unwrap().len();
    session
        .notice(&client, &settings, sample(STALE_WINDOW))
        .await;
    assert_eq!(offered_since(&client, before).len(), 1);
    assert!(session.latest.is_none(), "the refused view was rolled back");
    *client.refuse.lock().unwrap() = false;
    let newest = runner.last().map(cursor);
    session
        .notice(&client, &settings, notice(&session, 2, newest))
        .await;
    let offered = offered_since(&client, before);
    assert_eq!(offered.len(), 2, "the rebuild was not offered again");
    assert_eq!(
        session.latest.as_ref().map(|latest| latest.version),
        offered.last().map(|view| view.version)
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// (c) An `apply_view` answer refusing a view with `edit_before_cut` (an edit
/// at or before the view's own cut, which ck-mc never builds) is an ordinary
/// refusal: the view is rolled back, and the session goes on to offer its
/// work again.
#[tokio::test]
async fn compaction_undo_v1_an_edit_before_cut_refusal_is_an_ordinary_refusal() {
    let answer: ApplyViewAnswer = serde_json::from_slice(EDIT_BEFORE_CUT).unwrap();
    let ApplyViewAnswer::Refused { refusal } = answer.clone() else {
        panic!("not a refusal: {answer:?}");
    };
    assert!(
        matches!(&refusal, ViewRefusal::EditBeforeCut { index: 2, mid } if mid == "msg_00000017"),
        "{refusal:?}"
    );
    let dir = scratch("undo-v1-c");
    let (mut session, client, settings) = view_2_applied(&dir, transcript()).await;
    // The client answers with the refusal it is given, so with the sample's body.
    *client.refuse.lock().unwrap() = true;
    *client.refusal.lock().unwrap() = Some(refusal);
    let queued = (mid(20), "0".to_owned());
    session.queued.insert(queued.clone());
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the queued drop makes a view");
    assert!(names_part(&view, &queued));
    assert!(!session.publish(&client, view).await);
    assert_eq!(
        session.latest.as_ref().map(|latest| latest.version),
        Some(2),
        "view 2 still stands"
    );
    assert!(session.queued.contains(&queued), "the drop stays queued");
    *client.refuse.lock().unwrap() = false;
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the queued drop is offered again");
    assert!(names_part(&view, &queued));
    assert!(session.publish(&client, view).await);
    assert!(!session.queued.contains(&queued), "the drop landed");
    std::fs::remove_dir_all(dir).unwrap();
}

/// A Setup on the samples' conditions: the runner's transcript ends at
/// `newest`, and the runner applies `applied`.
fn setup_request(newest: &Entry, applied: Option<&View>) -> SetupRequest {
    let (_, _, _, mut request, _) = fixture();
    let conditions = sample(UNDO).conditions;
    request.model = conditions.model;
    request.context_window = conditions.context_window;
    request.output_reserve = conditions.output_reserve;
    request.rules = conditions.rules;
    request.newest = Some(cursor(newest));
    request.applied_view = applied.map(View::applied);
    request
}

/// Whether `view`'s history head shows the summary that ends on
/// `msg_00000017`.
fn shows_second_summary(view: &View) -> bool {
    serde_json::to_string(&view.edits)
        .unwrap()
        .contains(&format!("what happened through {}", mid(18)))
}

/// After ck-mc restarted, the runner set up again having lost view 2: it
/// applies no view, and a session past its host's compaction marker takes
/// no step without one, so no notice may come. Setup builds and offers a
/// view in its own pass: the history head and the cut through
/// `msg_00000017`.
#[tokio::test]
async fn compaction_undo_v1_a_setup_without_the_runners_view_offers_one() {
    let dir = scratch("undo-v1-setup-none");
    let (session, client, settings) = view_2_applied(&dir, transcript()).await;
    let durable = session.durable();
    let (mut restored, _, route, _, _) = fixture();
    restored.db = session.db.clone();
    restored.load_summaries();
    restored.restore(durable);
    let runner = client.entries.lock().unwrap().clone();
    let request = setup_request(runner.last().unwrap(), None);
    let before = client.offered.lock().unwrap().len();
    restored
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    let offered = offered_since(&client, before);
    let [view] = &offered[..] else {
        panic!("{} views offered during Setup", offered.len());
    };
    assert_eq!(cut_through(view), Some(mid(18).as_str()));
    assert!(shows_second_summary(view), "{:?}", view.edits);
    cortexkit_compaction_view::render::apply(&runner, view)
        .expect("the runner can apply the view to its transcript");
    assert_eq!(
        restored.latest.as_ref().map(|latest| latest.version),
        Some(view.version)
    );
    assert!(
        !restored.head_stale,
        "the view the runner took shows the head"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// A runner restored from its own backup sets up applying ck-mc's view 1,
/// older than view 2, the one it last applied. Setup takes view 1 back and
/// offers a newer view in its own pass, showing the summary view 1 lacks
/// and cutting where the summaries end.
#[tokio::test]
async fn compaction_undo_v1_a_setup_with_an_older_view_offers_a_newer_one() {
    let dir = scratch("undo-v1-setup-older");
    let (mut session, client, _, _, settings) = fixture();
    session.conditions = sample(UNDO).conditions;
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    summary(&db, 1, 1, 10);
    session.db = Some(Arc::new(db));
    session.features.summarizer = true;
    session.load_summaries();
    let runner = transcript();
    session.index.extend(runner.clone());
    *client.entries.lock().unwrap() = runner.clone();
    let (view_1, _) = session.build(&settings, None, false, None);
    let view_1 = view_1.expect("the first summary is not shown yet");
    assert_eq!(cut_through(&view_1), Some(mid(10).as_str()));
    assert!(session.publish(&client, view_1.clone()).await);
    session.settle_unconfirmed(Some(&view_1.applied()), &[]);
    summary(session.db.as_deref().unwrap(), 2, 11, 18);
    session.load_summaries();
    session.summary_unshown = true;
    let (view_2, _) = session.build(&settings, None, false, None);
    let view_2 = view_2.expect("the second summary is not shown yet");
    assert_eq!(cut_through(&view_2), Some(mid(18).as_str()));
    assert!(session.publish(&client, view_2.clone()).await);
    session.settle_unconfirmed(Some(&view_2.applied()), &[]);
    *client.applied.lock().unwrap() = Some(AppliedViewAnswer::new().with_view(view_1.clone()));
    let request = setup_request(runner.last().unwrap(), Some(&view_1));
    let (_, _, route, _, _) = fixture();
    let before = client.offered.lock().unwrap().len();
    let features = session.features;
    session
        .setup(&client, &settings, &route, &request, features)
        .await;
    let offered = offered_since(&client, before);
    let [view] = &offered[..] else {
        panic!("{} views offered during Setup", offered.len());
    };
    assert!(view.version > view_2.version);
    assert_eq!(cut_through(view), Some(mid(18).as_str()));
    assert!(shows_second_summary(view), "{:?}", view.edits);
    cortexkit_compaction_view::render::apply(&runner, view)
        .expect("the runner can apply the view to its transcript");
    std::fs::remove_dir_all(dir).unwrap();
}

/// A Setup whose runner applies ck-mc's current view offers nothing.
#[tokio::test]
async fn compaction_undo_v1_a_setup_with_the_current_view_offers_nothing() {
    let dir = scratch("undo-v1-setup-current");
    let (mut session, client, settings) = view_2_applied(&dir, transcript()).await;
    let view_2 = session.latest.clone().unwrap();
    *client.applied.lock().unwrap() = Some(AppliedViewAnswer::new().with_view(view_2.clone()));
    let runner = client.entries.lock().unwrap().clone();
    let request = setup_request(runner.last().unwrap(), Some(&view_2));
    let (_, _, route, _, _) = fixture();
    let before = client.offered.lock().unwrap().len();
    let features = session.features;
    session
        .setup(&client, &settings, &route, &request, features)
        .await;
    assert_eq!(client.offered.lock().unwrap().len(), before);
    assert_eq!(
        session.latest.as_ref().map(|latest| latest.version),
        Some(2)
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// The view Setup offers to a runner without one, refused in its turn,
/// stays due: the next notice offers one again, whatever the usage.
#[tokio::test]
async fn compaction_undo_v1_a_refused_setup_offer_stays_due() {
    let dir = scratch("undo-v1-setup-refused");
    let (mut session, client, settings) = view_2_applied(&dir, transcript()).await;
    let runner = client.entries.lock().unwrap().clone();
    let request = setup_request(runner.last().unwrap(), None);
    let (_, _, route, _, _) = fixture();
    *client.refuse.lock().unwrap() = true;
    let before = client.offered.lock().unwrap().len();
    let features = session.features;
    session
        .setup(&client, &settings, &route, &request, features)
        .await;
    assert_eq!(offered_since(&client, before).len(), 1);
    assert!(session.latest.is_none(), "the refused view was rolled back");
    *client.refuse.lock().unwrap() = false;
    let newest = runner.last().map(cursor);
    session
        .notice(&client, &settings, notice(&session, 1, newest))
        .await;
    let offered = offered_since(&client, before);
    assert_eq!(offered.len(), 2, "the view was not offered again");
    assert_eq!(
        session.latest.as_ref().map(|latest| latest.version),
        offered.last().map(|view| view.version)
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// The runner dropped view 2 and refuses every view ck-mc offers. After two
/// forced views end refused with no new message, ck-mc stops forcing them
/// and logs that once. A new message lets it force one again.
#[tokio::test]
async fn compaction_undo_v1_forced_views_resume_once_the_transcript_grows() {
    let logs = crate::test_log::capture();
    let dir = scratch("undo-v1-bound-growth");
    let (mut session, client, settings) = view_2_applied(&dir, transcript()).await;
    *client.refuse.lock().unwrap() = true;
    let before = client.offered.lock().unwrap().len();
    for seq in 1..=4 {
        let newest = client.entries.lock().unwrap().last().map(cursor);
        session
            .notice(&client, &settings, notice(&session, seq, newest))
            .await;
    }
    assert_eq!(offered_since(&client, before).len(), 2);
    assert_eq!(logs.count("none is forced until the transcript grows"), 1);
    client.entries.lock().unwrap().push(Entry::new(
        25,
        mid(25),
        Role::User,
        1024,
        vec![text_part("0", tag(25), "message 25")],
    ));
    let newest = client.entries.lock().unwrap().last().map(cursor);
    session
        .notice(&client, &settings, notice(&session, 5, newest))
        .await;
    assert_eq!(
        offered_since(&client, before).len(),
        3,
        "a new message did not let ck-mc force a view again"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// After a ck-mc restart the runner's Setup says it applies no view, and
/// reading the runner's view back fails. The Setup's statement stands:
/// ck-mc offers a view in Setup's own pass.
#[tokio::test]
async fn compaction_undo_v1_a_setup_without_a_view_offers_one_when_the_read_back_fails() {
    let dir = scratch("undo-v1-setup-read-back-fails");
    let (session, client, settings) = view_2_applied(&dir, transcript()).await;
    let durable = session.durable();
    let (mut restored, _, route, _, _) = fixture();
    restored.db = session.db.clone();
    restored.load_summaries();
    restored.restore(durable);
    assert!(restored.latest_unknown);
    *client.fail_applied_view.lock().unwrap() = true;
    let runner = client.entries.lock().unwrap().clone();
    let request = setup_request(runner.last().unwrap(), None);
    let before = client.offered.lock().unwrap().len();
    restored
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    let offered = offered_since(&client, before);
    let [view] = &offered[..] else {
        panic!("{} views offered during Setup", offered.len());
    };
    assert_eq!(cut_through(view), Some(mid(18).as_str()));
    cortexkit_compaction_view::render::apply(&runner, view)
        .expect("the runner can apply the view to its transcript");
    std::fs::remove_dir_all(dir).unwrap();
}
