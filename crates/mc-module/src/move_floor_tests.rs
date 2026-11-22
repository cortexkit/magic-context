//! A session moved onto its runner never gets a view that cuts before the
//! entry its first view there cut through, or one with no cut (see
//! `move_floor`).

use super::*;
use cortexkit_role_compaction::ride::RideCause;

/// The move's cut: the entry before the newest one when the session moved.
const FLOOR: (u64, &str) = (9, "m9");
const RUNNER_FLOOR: (u64, &str) = (9, "msg_a2");

const APPLY_REFUSAL: &str =
    include_str!("../testdata/cut-before-move/apply-view-cut-before-move.json");
const NOTICE_CUT: &str = include_str!("../testdata/cut-before-move/notice-cut-before-move-0.json");
const NOTICE_NO_CUT: &str =
    include_str!("../testdata/cut-before-move/notice-cut-before-move-1.json");

fn summary(
    db: &ContextDb,
    sequence: i64,
    (start, start_mid): (u64, &str),
    (end, end_mid): (u64, &str),
) {
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at, harness) VALUES ('s1', ?1, ?2, ?3, ?4, ?5, 'work', 'what happened', 'what happened', 1, 'mock')",
            rusqlite::params![sequence, start as i64, end as i64, start_mid, end_mid],
        )
        .map_err(|error| error.to_string())
    })
    .unwrap();
}

fn transcript(through: u64) -> Vec<Entry> {
    (1..=through).map(|n| text(n, &format!("m{n}"))).collect()
}

fn cut_through(view: &View) -> Option<&str> {
    view.edits.iter().find_map(|edit| match &edit.op {
        EditOp::Cut { through } => Some(through.as_str()),
        _ => None,
    })
}

struct Moved {
    session: Session,
    client: Client,
    route: Route,
    setup: SetupRequest,
    settings: Settings,
    /// The view the move installed, which the runner applies.
    view: View,
    dir: Scratch,
}

/// A scratch folder, removed when the test ends.
struct Scratch(std::path::PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A session that moved with entries 1 to 10, its summaries reaching entry 9
/// and its first view cutting there. The newer summary ends on an id the
/// runner's transcript doesn't hold (the old host numbered it its own way),
/// so reconciling the summaries against the runner takes it away and leaves
/// them reaching entry 5, below the floor. With `floor` false the session
/// is the same in every other way but never moved: it has no floor.
fn moved(label: &str, floor: bool) -> Moved {
    moved_at(label, floor, FLOOR)
}

fn moved_at(label: &str, floor: bool, cut: (u64, &str)) -> Moved {
    let (mut session, client, route, setup, settings) = fixture();
    let dir = scratch(label);
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    summary(&db, 1, (1, "m1"), (5, "m5"));
    summary(&db, 2, (6, "m6"), (9, "host-9"));
    session.db = Some(Arc::new(db));
    session.features.summarizer = true;
    session.load_summaries();
    let view = session.first_view_after_move(&settings, Some(cut)).unwrap();
    assert_eq!(cut_through(&view), Some(cut.1));
    if !floor {
        session.move_floor = None;
    }
    let mut entries = transcript(10);
    entries[cut.0 as usize - 1] = text(cut.0, cut.1);
    *client.entries.lock().unwrap() = entries;
    let mut answer = AppliedViewAnswer::new();
    answer.view = Some(view.clone());
    *client.applied.lock().unwrap() = Some(answer);
    Moved {
        session,
        client,
        route,
        setup,
        settings,
        view,
        dir: Scratch(dir),
    }
}

impl Moved {
    /// The runner's Setup, reporting the moved view applied. Reconciling
    /// the summaries takes the newer one away.
    async fn set_up(&mut self) {
        let mut setup = self.setup.clone();
        setup.newest = self.client.entries.lock().unwrap().last().map(cursor);
        setup.applied_view = Some(self.view.applied());
        let features = self.session.features;
        self.session
            .setup(&self.client, &self.settings, &self.route, &setup, features)
            .await;
        assert_eq!(
            self.session.last_summary_ordinal(),
            Some(5),
            "the summaries were not reconciled below the floor"
        );
    }

    /// A notice for a new newest entry, with the moved view applied.
    async fn notice(&mut self, seq: u64) {
        let entry = text(10 + seq, &format!("m{}", 10 + seq));
        self.client.entries.lock().unwrap().push(entry.clone());
        let mut request = notice(&self.session, seq, Some(cursor(&entry)));
        request.entries = vec![entry];
        request.applied_view = self
            .session
            .latest
            .as_ref()
            .filter(|latest| **latest == self.view)
            .map(View::applied);
        self.session
            .notice(&self.client, &self.settings, request)
            .await;
    }

    fn offered(&self) -> Vec<View> {
        self.client.offered.lock().unwrap().clone()
    }
}

/// Summaries dropped below the move cut publish no view: not on a notice
/// that rebuilds the head, not on the next ones, and the runner keeps the
/// view the move installed. The hold is logged once, not on every pass.
#[tokio::test]
async fn move_floor_summaries_below_the_floor_publish_no_view() {
    let logs = crate::test_log::capture();
    let mut moved = moved("below-floor", true);
    moved.set_up().await;
    assert!(moved.session.head_stale, "the head must be rebuilt");
    for seq in 1..=3 {
        moved.notice(seq).await;
    }
    assert!(
        moved.offered().is_empty(),
        "a view cutting before the move floor was offered: {:?}",
        moved.offered().iter().map(cut_through).collect::<Vec<_>>()
    );
    assert_eq!(moved.session.latest.as_ref(), Some(&moved.view));
    assert_eq!(
        logs.count("cut_before_move_floor"),
        1,
        "logged once per hold"
    );
    assert_eq!(logs.count("move floor entry 9 (m9)"), 1);
    assert_eq!(logs.count("summaries reach entry 5 (m5)"), 1);
}

/// Once a new summary reaches past the floor, the next rebuild publishes a
/// view again, cutting where that summary ends.
#[tokio::test]
async fn move_floor_a_summary_past_the_floor_publishes_again() {
    let logs = crate::test_log::capture();
    let mut moved = moved("back-above", true);
    moved.set_up().await;
    moved.notice(1).await;
    assert!(moved.offered().is_empty());
    summary(
        moved.session.db.as_ref().unwrap(),
        3,
        (6, "m6"),
        (10, "m10"),
    );
    moved.session.load_summaries();
    moved.session.summary_unshown = true;
    moved.notice(2).await;
    let offered = moved.offered();
    assert_eq!(
        offered.len(),
        1,
        "no view after the summaries reached the floor"
    );
    assert_eq!(cut_through(&offered[0]), Some("m10"));
    assert!(moved.session.cut >= Some(FLOOR.0));
    assert_eq!(logs.count("views publish again"), 1);
}

/// An over-limit ride while the summaries sit below the floor answers with
/// no view, as it does when it has nothing to land.
#[tokio::test]
async fn move_floor_an_over_limit_ride_below_the_floor_answers_nothing() {
    let mut moved = moved("over-limit", true);
    moved.set_up().await;
    let mut conditions = moved.session.conditions.clone();
    conditions.last_prompt_tokens = Some(98_000);
    let ride = RideRequest::new(vec![RideCause::OverLimit], 1_000, conditions)
        .with_request_tokens(120_000);
    let answer = moved.session.ride(&moved.settings, &ride);
    assert!(
        answer.is_none(),
        "an over-limit ride answered a view cutting through {:?}",
        answer.as_ref().and_then(cut_through)
    );
    assert_eq!(moved.session.latest.as_ref(), Some(&moved.view));
}

/// The same summaries and transcript in a session that never moved behave
/// as before: the next rebuild cuts where the remaining summaries end.
#[tokio::test]
async fn move_floor_a_session_that_never_moved_is_unchanged() {
    let mut session = moved("never-moved-notice", false);
    session.set_up().await;
    session.notice(1).await;
    let offered = session.offered();
    assert_eq!(offered.len(), 1);
    assert_eq!(cut_through(&offered[0]), Some("m5"));

    let mut session = moved("never-moved-ride", false);
    session.set_up().await;
    let mut conditions = session.session.conditions.clone();
    conditions.last_prompt_tokens = Some(98_000);
    let ride = RideRequest::new(vec![RideCause::OverLimit], 1_000, conditions)
        .with_request_tokens(120_000);
    let answer = session.session.ride(&session.settings, &ride);
    assert_eq!(answer.as_ref().and_then(cut_through), Some("m5"));
}

/// A moved session never publishes a view with no cut. Below the floor a
/// queued drop alone builds nothing; at the floor, a view whose cut can't
/// be built (the newest summary ends on an entry the index doesn't hold)
/// stays in ck-mc, where a session that never moved would publish it.
#[tokio::test]
async fn move_floor_a_moved_session_never_publishes_a_view_without_a_cut() {
    let mut moved = moved("only-drops", true);
    moved.set_up().await;
    moved.notice(1).await;
    moved.session.queued.insert(("m10".into(), "p".into()));
    moved.notice(2).await;
    assert!(moved.offered().is_empty());
    assert!(
        moved.session.queued.contains(&("m10".into(), "p".into())),
        "a held drop was forgotten"
    );

    for floor in [true, false] {
        let (mut session, _, _, _, settings) = fixture();
        let dir = scratch("no-cut");
        let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
        summary(&db, 1, (1, "m1"), (10, "host-10"));
        session.db = Some(Arc::new(db));
        session.features.summarizer = true;
        session.load_summaries();
        session.index.extend(transcript(12));
        if floor {
            session.set_move_floor(Some(FLOOR));
        }
        session.queued.insert(("m10".into(), "p".into()));
        let (view, _) = session.build(&settings, None, false, None);
        if floor {
            assert!(view.is_none(), "a view with no cut was built: {view:?}");
            assert!(session.queued.contains(&("m10".into(), "p".into())));
        } else {
            let view = view.expect("a session that never moved publishes");
            assert_eq!(cut_through(&view), None);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}

/// The floor is part of the session's saved state: after a restart that
/// reloads the session from the store, views still don't cut before it.
#[tokio::test]
async fn move_floor_survives_a_restart() {
    let moved = moved("restart", true);
    let store = Arc::new(crate::store::Store::open(&moved.dir.0.join("mode3.db")).unwrap());
    store
        .save(&moved.route.session, &moved.session.durable())
        .unwrap();
    let mut restored = Session::new(
        &moved.route,
        &moved.setup,
        moved.session.features,
        moved.session.db.clone(),
    );
    restored.set_store(Some(Arc::clone(&store)));
    restored.load_summaries();
    restored.restore(store.load(&moved.route.session).unwrap());
    assert_eq!(
        restored.move_floor,
        Some(MoveFloor {
            ordinal: FLOOR.0,
            mid: FLOOR.1.into()
        })
    );
    let mut moved = Moved {
        session: restored,
        ..moved
    };
    moved.set_up().await;
    moved.notice(1).await;
    assert!(moved.offered().is_empty());
}

/// A session moved before ck-mc saved the floor has only its move fence,
/// which names the cut entry by id. Setup reads the fence and has the runner
/// place that entry, and the floor holds from then on.
#[tokio::test]
async fn move_floor_a_session_moved_earlier_takes_its_floor_from_the_fence() {
    let mut moved = moved("fence", true);
    moved.session.move_floor = None;
    let fence = serde_json::json!({
        "version": 3, "session": "s1", "harness": "mock", "runner": "test",
        "state": "moved", "cut": FLOOR.1, "view_version": 1,
    });
    moved
        .session
        .db
        .as_ref()
        .unwrap()
        .with_connection(|conn| {
            conn.execute(
                "INSERT INTO schema_migrations_meta (key, value) VALUES (?1, ?2)",
                rusqlite::params![crate::move_in::fence_key("mock", "s1"), fence.to_string()],
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    moved.set_up().await;
    assert_eq!(
        moved.session.move_floor,
        Some(MoveFloor {
            ordinal: FLOOR.0,
            mid: FLOOR.1.into()
        })
    );
    assert!(moved
        .client
        .reads
        .lock()
        .unwrap()
        .iter()
        .any(|read| matches!(
            &read.select,
            Select::Mids { mids } if mids == &[FLOOR.1.to_string()]
        )));
    moved.notice(1).await;
    assert!(moved.offered().is_empty());
    assert!(moved.session.durable().move_floor.is_some());
}

/// A moved session holding, after a restart, an unconfirmed view whose cut
/// is `through`, with its transcript in the runner but not yet in the index.
async fn reoffering(through: &str) -> (Session, Client, Settings, View) {
    let (mut session, client, route, mut setup, settings) = fixture();
    *client.entries.lock().unwrap() = transcript(12);
    setup.newest = client.entries.lock().unwrap().last().map(cursor);
    let features = session.features;
    session
        .setup(&client, &settings, &route, &setup, features)
        .await;
    session.set_move_floor(Some(FLOOR));
    let view = View::seal(
        1,
        vec![cortexkit_role_compaction::view::Edit::new(
            1,
            EditOp::Cut {
                through: through.into(),
            },
        )],
    );
    session.accept(view.clone());
    // As after a restart: the index fills only after the view is offered.
    session.index = Index::starting_at(1);
    client.reads.lock().unwrap().clear();
    (session, client, settings, view)
}

/// A view offered again whose cut is the floor entry itself meets the floor
/// by id: no runner read places it first.
#[tokio::test]
async fn move_floor_a_reoffered_view_cutting_at_the_floor_reads_nothing() {
    let (mut session, client, _, view) = reoffering(FLOOR.1).await;
    session.offer_unconfirmed_again(&client).await;
    assert!(
        client.reads.lock().unwrap().is_empty(),
        "the floor entry was read to place it"
    );
    assert_eq!(client.offered.lock().unwrap().clone(), vec![view]);
}

/// A runner that can't place a reoffered view's cut yet (`transient`)
/// leaves the view's fate open: it is neither rolled back nor counted as a
/// breach, and the next notice offers it again.
#[tokio::test]
async fn move_floor_a_transient_refusal_offers_the_view_again_later() {
    let (mut session, client, settings, view) = reoffering("m10").await;
    client
        .pages
        .lock()
        .unwrap()
        .push_back(Err(crate::client::ClientError::refused(
            "transient",
            "index_filling",
        )));
    session.offer_unconfirmed_again(&client).await;
    assert!(client.offered.lock().unwrap().is_empty());
    assert_eq!(session.unconfirmed.len(), 1, "the view was rolled back");
    assert_eq!(session.latest.as_ref(), Some(&view));
    assert!(
        !session.move_floor_held,
        "a transient read counted as a breach"
    );

    let entry = text(13, "m13");
    client.entries.lock().unwrap().push(entry.clone());
    let mut request = notice(&session, 1, Some(cursor(&entry)));
    request.entries = vec![entry];
    session.notice(&client, &settings, request).await;
    assert_eq!(client.offered.lock().unwrap().first(), Some(&view));
}

#[test]
fn move_floor_refusal_samples_round_trip() {
    use sha2::{Digest, Sha256};

    let sums = include_str!("../testdata/cut-before-move/SHA256SUMS");
    for (name, raw) in [
        ("apply-view-cut-before-move.json", APPLY_REFUSAL),
        ("notice-cut-before-move-0.json", NOTICE_CUT),
        ("notice-cut-before-move-1.json", NOTICE_NO_CUT),
        (
            "README.md",
            include_str!("../testdata/cut-before-move/README.md"),
        ),
    ] {
        let line = format!("{:x}  {name}", Sha256::digest(raw.as_bytes()));
        assert!(sums.lines().any(|sum| sum == line), "{name} changed");
    }

    let apply: ApplyViewAnswer = serde_json::from_str(APPLY_REFUSAL).unwrap();
    assert!(matches!(&apply, ApplyViewAnswer::Refused {
        refusal: ViewRefusal::CutBeforeMove { moved_through }
    } if moved_through == RUNNER_FLOOR.1));
    assert_eq!(
        serde_json::to_value(apply).unwrap(),
        serde_json::from_str::<Value>(APPLY_REFUSAL).unwrap()
    );
    for raw in [NOTICE_CUT, NOTICE_NO_CUT] {
        let notice: NoticeRequest = serde_json::from_str(raw).unwrap();
        assert!(matches!(notice.events.as_slice(), [Event::ViewRefused {
            version: 2, refusal: ViewRefusal::CutBeforeMove { moved_through }
        }] if moved_through == RUNNER_FLOOR.1));
        assert_eq!(
            serde_json::to_value(notice).unwrap(),
            serde_json::from_str::<Value>(raw).unwrap()
        );
    }
}

fn assert_refusal_preserves_drop(session: &Session, key: &lanes::PartKey) {
    assert!(session.queued.contains(key), "the refused drop was lost");
    assert!(session.refused_once.is_empty(), "the drop was blamed");
    assert!(session.failed_parts.is_empty(), "parts were set aside");
}

async fn moved_without_floor(label: &str) -> Moved {
    let mut moved = moved_at(label, false, RUNNER_FLOOR);
    moved
        .client
        .entries
        .lock()
        .unwrap()
        .extend([text(11, "m11"), text(12, "m12")]);
    moved.set_up().await;
    assert_eq!(moved.session.move_floor, None);
    moved
}

#[tokio::test]
async fn move_floor_apply_refusal_teaches_the_missing_floor() {
    let logs = crate::test_log::capture();
    let mut moved = moved_without_floor("apply-cut-before-move").await;
    let key = ("m10".into(), "p".into());
    moved.session.queued.insert(key.clone());
    let (view, _) = moved.session.build(&moved.settings, None, false, None);
    let view = view.expect("the cut was allowed without a floor");
    assert_eq!(cut_through(&view), Some("m5"));
    assert!(moved.session.next_covered.contains(&key));
    let ApplyViewAnswer::Refused { refusal } = serde_json::from_str(APPLY_REFUSAL).unwrap() else {
        panic!("expected a refusal sample");
    };
    *moved.client.refuse.lock().unwrap() = true;
    *moved.client.refusal.lock().unwrap() = Some(refusal);
    assert!(!moved.session.publish(&moved.client, view).await);

    assert_refusal_preserves_drop(&moved.session, &key);
    let durable = moved.session.durable();
    assert_eq!(
        durable.move_floor,
        Some(MoveFloor {
            ordinal: RUNNER_FLOOR.0,
            mid: RUNNER_FLOOR.1.into()
        })
    );
    assert_eq!(
        logs.count("cut_before_move through msg_a2 (previous move floor: none)"),
        1
    );
    moved.notice(3).await;
    assert!(
        moved.session.move_floor_held,
        "the next rebuild did not reach the hold"
    );
    assert_eq!(
        moved.offered().len(),
        1,
        "the refused cut was offered again"
    );
    assert_eq!(moved.session.latest.as_ref(), Some(&moved.view));
}

#[tokio::test]
async fn move_floor_notice_refusal_advances_an_earlier_floor() {
    let mut moved = moved_without_floor("notice-cut-before-move").await;
    moved.session.set_move_floor(Some((5, "m5")));
    let key = ("m10".into(), "p".into());
    moved.session.queued.insert(key.clone());
    let mut conditions = moved.session.conditions.clone();
    conditions.last_prompt_tokens = Some(98_000);
    let ride = RideRequest::new(vec![RideCause::OverLimit], 1_000, conditions)
        .with_request_tokens(120_000);
    let view = moved
        .session
        .ride(&moved.settings, &ride)
        .expect("the cut reaches the old floor");
    assert_eq!(view.version, 2);
    assert_eq!(cut_through(&view), Some("m5"));
    assert!(
        !moved.session.queued.contains(&key),
        "the ride did not carry the drop"
    );

    // After a restart the pending view is saved, but the index may not hold
    // the entry in the refusal. The runner must place it by id.
    moved.session.index = Index::starting_at(5);
    moved.session.index_ready = false;
    let mut request: NoticeRequest = serde_json::from_str(NOTICE_CUT).unwrap();
    request.applied_view = Some(moved.view.applied());
    request.newest = moved.client.entries.lock().unwrap().last().map(cursor);
    moved
        .session
        .notice(&moved.client, &moved.settings, request)
        .await;

    assert_refusal_preserves_drop(&moved.session, &key);
    assert_eq!(
        moved.session.move_floor,
        Some(MoveFloor {
            ordinal: RUNNER_FLOOR.0,
            mid: RUNNER_FLOOR.1.into()
        })
    );
    assert!(moved
        .client
        .reads
        .lock()
        .unwrap()
        .iter()
        .any(|read| matches!(
            &read.select, Select::Mids { mids } if mids == &[RUNNER_FLOOR.1.to_owned()]
        )));
    assert!(
        moved.offered().is_empty(),
        "the refused cut was offered again"
    );
    assert_eq!(moved.session.latest.as_ref(), Some(&moved.view));
}

#[tokio::test]
async fn move_floor_notice_refusal_does_not_lower_a_later_floor() {
    let (mut session, client, route, mut setup, settings) = fixture();
    let mut entries = transcript(13);
    entries[8] = text(RUNNER_FLOOR.0, RUNNER_FLOOR.1);
    setup.newest = entries.last().map(cursor);
    *client.entries.lock().unwrap() = entries;
    let features = session.features;
    session
        .setup(&client, &settings, &route, &setup, features)
        .await;
    let key = ("m4".into(), "p".into());
    session.queued.insert(key.clone());
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("a view with just the drop");
    assert_eq!(cut_through(&view), None);
    assert!(session.next_covered.contains(&key));
    assert!(session.publish(&client, view.clone()).await);
    // The floor is known now, but was not when this view was handed over.
    session.set_move_floor(Some((10, "m10")));
    let mut request: NoticeRequest = serde_json::from_str(NOTICE_NO_CUT).unwrap();
    request.applied_view = None;
    request.newest = setup.newest;
    let Event::ViewRefused { version, .. } = &mut request.events[0] else {
        panic!("expected a refusal event");
    };
    *version = view.version;
    session.notice(&client, &settings, request).await;

    assert_refusal_preserves_drop(&session, &key);
    assert_eq!(
        session.move_floor,
        Some(MoveFloor {
            ordinal: 10,
            mid: "m10".into()
        })
    );
}

#[tokio::test]
async fn move_floor_notice_retries_unplaced_floor_without_repeating_the_warning() {
    let logs = crate::test_log::capture();
    let (mut session, client, route, mut setup, settings) = fixture();
    let entries = transcript(6);
    setup.newest = entries.last().map(cursor);
    *client.entries.lock().unwrap() = entries;
    let features = session.features;
    session
        .setup(&client, &settings, &route, &setup, features)
        .await;
    session.set_move_floor(Some((2, "m2")));
    client
        .pages
        .lock()
        .unwrap()
        .push_back(Err(crate::client::ClientError::refused(
            "transient",
            "index_filling",
        )));

    for (offset, mid) in ["unplaced", "absent", "unplaced", "absent"]
        .into_iter()
        .enumerate()
    {
        let mut request = notice(&session, offset as u64 + 1, setup.newest.clone());
        request.events.push(Event::ViewRefused {
            version: 2,
            refusal: ViewRefusal::CutBeforeMove {
                moved_through: mid.into(),
            },
        });
        session.notice(&client, &settings, request).await;
        assert_eq!(session.move_floor.as_ref().unwrap().ordinal, 2);
    }
    assert_eq!(logs.count("cannot place the runner's move floor"), 2);
    assert_eq!(logs.count("cut_before_move through unplaced"), 1);
    assert_eq!(logs.count("cut_before_move through absent"), 1);

    let entry = text(7, "unplaced");
    client.entries.lock().unwrap().push(entry.clone());
    let mut request = notice(&session, 5, Some(cursor(&entry)));
    request.events.push(Event::ViewRefused {
        version: 3,
        refusal: ViewRefusal::CutBeforeMove {
            moved_through: entry.mid,
        },
    });
    session.notice(&client, &settings, request).await;
    assert_eq!(
        session.move_floor,
        Some(MoveFloor {
            ordinal: 7,
            mid: "unplaced".into()
        })
    );
    assert_eq!(logs.count("adopting move floor at entry 7"), 1);
}
