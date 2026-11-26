//! A view handed to the runner whose `session.apply_view` got no answer: the
//! request was sent, but its deadline passed before the runner answered. The
//! runner may hold the view or may never have received it, so ck-mc keeps it
//! as handed over instead of rolling it back, and the runner's next report
//! settles it, as for a view handed over just before ck-mc restarted.

use super::*;
use crate::test_log::capture;

/// What the acceptance line of a view confirmed only by the runner's report
/// says after the usual line, up to the time the view was handed over.
const CONFIRMED: &str =
    "; confirmed by the runner after its apply answer was lost; handed over at ";

/// Milliseconds since the Unix epoch, by the wall clock.
fn wall_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// The one line in `logs` that says `view` was accepted, and that line
/// ends with the confirmation note and an RFC 3339 UTC time to the
/// millisecond, between `from` and `to` (wall clock, ms). Two lines, a line
/// without the note, or one with anything after the time fail.
fn assert_confirmed_once(logs: &str, view: &View, from: i64, to: i64) {
    let line = accepted_line(view);
    let found: Vec<&str> = logs.lines().filter(|text| text.contains(&line)).collect();
    let [found] = found[..] else {
        panic!(
            "view {} accepted {} times: {logs}",
            view.version,
            found.len()
        );
    };
    let shape = regex::Regex::new(&format!(
        r"{} note={}(\d{{4}}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{{3}}Z)$",
        regex::escape(&line),
        regex::escape(CONFIRMED)
    ))
    .unwrap();
    let handed = shape
        .captures(found)
        .unwrap_or_else(|| panic!("not in the confirmed shape: {found}"))[1]
        .to_owned();
    // Times in this one shape sort as text in time order.
    let (from, to) = (crate::upkeep::iso_8601(from), crate::upkeep::iso_8601(to));
    assert!(
        from <= handed && handed <= to,
        "handed over at {handed}, outside the handover call ({from} to {to})"
    );
}

/// The acceptance sentence and view fields recorded for `view`.
fn accepted_line(view: &View) -> String {
    let cut = view
        .edits
        .iter()
        .find_map(|edit| match &edit.op {
            EditOp::Cut { through } => Some(format!("cut through {through}")),
            _ => None,
        })
        .unwrap_or_else(|| "no cut".into());
    format!(
        "ck-mc: session: view accepted session=s1 view_version={} edit_count={} cut={cut}",
        view.version,
        view.edits.len()
    )
}

/// The status the apps' view history shows for view `version`.
fn status(session: &Session, version: u64) -> String {
    session
        .app_decisions
        .iter()
        .find(|record| record["view_version"] == version)
        .and_then(|record| record["status"].as_str())
        .expect("the view is in the apps' history")
        .to_owned()
}

/// How many times view `version` was handed to the runner.
fn offers_of(client: &Client, version: u64) -> usize {
    client
        .offered
        .lock()
        .unwrap()
        .iter()
        .filter(|view| view.version == version)
        .count()
}

/// The session of `refusal_fixture` (two old outputs the age sweep picks and
/// two queued drops) after it handed over its first view, which carries the
/// queued drops, and the call's answer was lost.
async fn handed_without_answer() -> (Session, Client, Settings, View, bool) {
    let (mut session, client, settings) = refusal_fixture();
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the old outputs and queued drops build a view");
    assert_carries_queued_drops(&view);
    *client.lose_apply_answers.lock().unwrap() = 1;
    let delivered = session.publish(&client, view.clone()).await;
    (session, client, settings, view, delivered)
}

/// A notice whose runner reports applying `applied` and refuses nothing.
async fn notice_reporting(
    session: &mut Session,
    client: &Client,
    settings: &Settings,
    seq: u64,
    applied: Option<&View>,
) {
    let newest = client.entries.lock().unwrap().last().map(cursor);
    let mut request = notice(session, seq, newest);
    request.applied_view = applied.map(View::applied);
    session.notice(client, settings, request).await;
}

/// The runner took the view though its answer was lost: nothing is rolled
/// back, and the runner's next report confirms the view and logs its
/// acceptance once, in the analyzer's shape followed by the confirmation
/// note and the time the view was handed over.
#[tokio::test]
async fn lost_answer_a_view_the_runner_holds_is_kept_and_confirmed_once() {
    let mut logs = capture();
    let from = wall_ms();
    let (mut session, client, settings, view, delivered) = handed_without_answer().await;
    let to = wall_ms();
    assert!(
        delivered,
        "a view whose answer was lost was reported as not in the runner's hands"
    );
    assert_eq!(
        session.latest.as_ref(),
        Some(&view),
        "the view was rolled back"
    );
    assert_eq!(session.unconfirmed.len(), 1, "the view was rolled back");
    assert_eq!(session.unconfirmed[0].view, view);
    assert!(
        session.queued.is_disjoint(&queued_refusal_parts()),
        "the view's queued drops were queued again: {:?}",
        session.queued
    );
    assert!(
        session.failed_parts.is_empty(),
        "{:?}",
        session.failed_parts
    );
    assert_eq!(status(&session, view.version), "offered");
    assert_eq!(
        logs.count("ck-mc: session: view accepted "),
        0,
        "no acceptance is logged before the runner says it took the view: {}",
        logs.text()
    );

    notice_reporting(&mut session, &client, &settings, 1, Some(&view)).await;
    assert!(
        session.unconfirmed.is_empty(),
        "the runner's report did not confirm the view"
    );
    assert_eq!(status(&session, view.version), "applied");
    assert_eq!(
        offers_of(&client, view.version),
        1,
        "a view the runner reports applying was offered again"
    );
    notice_reporting(&mut session, &client, &settings, 2, Some(&view)).await;
    logs.stop();
    assert_confirmed_once(&logs.text(), &view, from, to);
}

/// The runner never received the view: its next notice reports the view it
/// applied before and no refusal, so the view is offered again, as after a
/// restart, and the runner's acceptance of the offer says it holds it now.
#[tokio::test]
async fn lost_answer_a_view_the_runner_never_got_is_offered_again() {
    let (mut session, client, settings, view, _) = handed_without_answer().await;
    notice_reporting(&mut session, &client, &settings, 1, None).await;
    assert_eq!(
        offers_of(&client, view.version),
        2,
        "the view was not offered again"
    );
    let offered = client.offered.lock().unwrap().clone();
    assert_eq!(
        offered.iter().rfind(|offer| offer.version == view.version),
        Some(&view),
        "the view offered again differs from the one first handed over"
    );
    assert_eq!(session.latest.as_ref(), Some(&view));
    assert_eq!(session.unconfirmed.len(), 1);
    assert!(
        session.unconfirmed[0].accepted,
        "the runner's acceptance of the offer was not taken"
    );
    assert!(session.queued.is_disjoint(&queued_refusal_parts()));
    assert_eq!(status(&session, view.version), "accepted");
}

/// An offer again whose answer is lost too is not a failure either: the
/// view stays, and the following notice offers it once more.
#[tokio::test]
async fn lost_answer_an_offer_again_without_answer_waits_for_the_next_notice() {
    let (mut session, client, settings, view, _) = handed_without_answer().await;
    *client.lose_apply_answers.lock().unwrap() = 1;
    notice_reporting(&mut session, &client, &settings, 1, None).await;
    assert_eq!(offers_of(&client, view.version), 2);
    assert_eq!(
        session.unconfirmed.len(),
        1,
        "an offer whose answer was lost rolled the view back"
    );
    assert!(session.queued.is_disjoint(&queued_refusal_parts()));
    assert_ne!(status(&session, view.version), "undelivered");
    notice_reporting(&mut session, &client, &settings, 2, None).await;
    assert_eq!(offers_of(&client, view.version), 3);
    assert!(session.unconfirmed[0].accepted);
}

/// While the view waits, the next view is newer and carries its edits, so
/// the runner applying that one applies both; its report confirms the
/// waiting view as well and logs that view's acceptance.
#[tokio::test]
async fn lost_answer_the_next_view_is_newer_and_carries_the_waiting_one() {
    let mut logs = capture();
    let from = wall_ms();
    let (mut session, client, settings, view, _) = handed_without_answer().await;
    let to = wall_ms();
    let next = session
        .seal(
            vec![EditOp::Drop {
                mid: "next".into(),
                part: Some("p".into()),
            }],
            &[],
        )
        .expect("a further drop builds a view");
    assert!(
        next.version > view.version,
        "view {} reuses the waiting view's version {}",
        next.version,
        view.version
    );
    for edit in &view.edits {
        assert!(
            next.edits.iter().any(|carried| carried.op == edit.op),
            "view {} dropped the waiting view's edit {edit:?}",
            next.version
        );
    }
    assert!(session.publish(&client, next.clone()).await);
    assert_eq!(session.unconfirmed.len(), 2);
    notice_reporting(&mut session, &client, &settings, 1, Some(&next)).await;
    logs.stop();
    assert!(session.unconfirmed.is_empty());
    assert_eq!(status(&session, view.version), "applied");
    assert_eq!(status(&session, next.version), "applied");
    assert_confirmed_once(&logs.text(), &view, from, to);
    assert_eq!(logs.count(&accepted_line(&next)), 1, "{}", logs.text());
}

/// The time on a confirmation line is in the shape the cache-bust watcher
/// reads: RFC 3339, UTC, to the millisecond, ending in `Z`.
#[test]
fn lost_answer_the_handover_time_is_written_as_rfc_3339_utc_milliseconds() {
    assert_eq!(
        crate::upkeep::iso_8601(1_794_742_521_860),
        "2026-11-15T11:35:21.860Z"
    );
}

/// The runner held the view from the first handover, whose answer was lost:
/// it refuses the offer again as not newer than this very view. That answer
/// shows it took the view at the first handover, so the acceptance line is
/// written then, dated by the first handover, and the later confirmation
/// does not write it again.
#[tokio::test]
async fn lost_answer_an_offer_again_refused_as_held_logs_the_first_handover_once() {
    let mut logs = capture();
    let from = wall_ms();
    let (mut session, client, settings, view, _) = handed_without_answer().await;
    let to = wall_ms();
    *client.refuse.lock().unwrap() = true;
    *client.refusal.lock().unwrap() = Some(ViewRefusal::StaleVersion {
        version: view.version,
        latest: view.version,
    });
    notice_reporting(&mut session, &client, &settings, 1, None).await;
    assert_eq!(offers_of(&client, view.version), 2, "offered again");
    assert_eq!(session.unconfirmed.len(), 1, "a held view was rolled back");
    assert!(session.unconfirmed[0].accepted);
    assert_eq!(
        logs.count(&accepted_line(&view)),
        1,
        "the runner's answer to the offer again did not log the acceptance: {}",
        logs.text()
    );
    notice_reporting(&mut session, &client, &settings, 2, Some(&view)).await;
    logs.stop();
    assert!(session.unconfirmed.is_empty());
    assert_confirmed_once(&logs.text(), &view, from, to);
}

/// A view whose answer was lost is saved with that fact and the handover
/// time; a view the runner answered saves without either field, as views
/// were saved before.
#[tokio::test]
async fn lost_answer_only_a_lost_answer_adds_to_the_saved_view() {
    let (session, _, _, _, _) = handed_without_answer().await;
    let saved = serde_json::to_value(session.durable()).unwrap();
    let pending = &saved["unconfirmed"][0];
    assert_eq!(pending["answer_lost"], true, "{pending}");
    assert!(pending["handed_over_ms"].as_i64().is_some(), "{pending}");

    let (mut session, client, settings) = refusal_fixture();
    let (view, _) = session.build(&settings, None, false, None);
    assert!(session.publish(&client, view.expect("a view")).await);
    let saved = serde_json::to_value(session.durable()).unwrap();
    let pending = saved["unconfirmed"][0].as_object().expect("a saved view");
    for field in ["answer_lost", "handed_over_ms"] {
        assert!(
            !pending.contains_key(field),
            "an answered view saved `{field}`"
        );
    }
}

/// A call that failed outright (the connection dropped before the request
/// went out) still rolls the view back: its queued drops are queued again
/// and the apps show it undelivered.
#[tokio::test]
async fn lost_answer_a_failed_call_still_rolls_the_view_back() {
    let (mut session, client, settings) = refusal_fixture();
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the old outputs and queued drops build a view");
    *client.fail_apply.lock().unwrap() = true;
    assert!(!session.publish(&client, view.clone()).await);
    assert!(session.unconfirmed.is_empty());
    assert!(session.latest.is_none());
    assert_eq!(session.queued, queued_refusal_parts());
    assert_eq!(status(&session, view.version), "undelivered");
    assert!(!session.reoffer_pending);
}
