//! Review witnesses for views whose `session.apply_view` answer was lost.
//!
//! Each test states a property the lost-answer handling should keep and
//! fails on the code as it stands, so each is ignored with the reason it
//! fails. Remove the `#[ignore]` once the behaviour it names is fixed.

use super::*;
use crate::test_log::capture;

/// Milliseconds since the Unix epoch, by the wall clock.
fn wall_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// The acceptance line for `view` without the session prefix, in the shape
/// the cache-bust analyzer parses: `view N accepted (E edits, cut through
/// X)` or `view N accepted (E edits, no cut)`.
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
        "view {} accepted ({} edits, {cut})",
        view.version,
        view.edits.len()
    )
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

/// Every view handed to the runner, in order.
fn offered(client: &Client) -> Vec<View> {
    client.offered.lock().unwrap().clone()
}

/// The session of `refusal_fixture` (two old outputs the age sweep picks,
/// `old`/`p` and `old`/`p2`, and two queued drops) after it handed over its
/// first view, which carries all four, and the call's answer was lost.
async fn handed_without_answer() -> (Session, Client, Settings, View) {
    let (mut session, client, settings) = refusal_fixture();
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the old outputs and queued drops build a view");
    assert_carries_queued_drops(&view);
    *client.lose_apply_answers.lock().unwrap() = 1;
    assert!(session.publish(&client, view.clone()).await);
    assert_eq!(session.latest.as_ref(), Some(&view));
    assert!(
        session.reoffer_pending,
        "the next notice offers the view again"
    );
    (session, client, settings, view)
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

/// The runner refused the view and named the one part at fault, but that
/// answer was lost. Offering the view again on the next notice gets the same
/// refusal. A refusal on first handover sets aside only the named part
/// (`lifecycle_a_refusal_naming_a_part_sets_aside_only_that_part`), and
/// gives the queued drops it did not name no refusal strike; the refusal of
/// the offer again should do the same.
#[tokio::test]
#[ignore = "fails: offer_unconfirmed_again rolls back without the refusal's named part, so every automatic part of the view is set aside and every queued drop gets a refusal strike"]
async fn lost_answer_review_a_refused_offer_again_sets_aside_only_the_named_part() {
    let (mut session, client, _, view) = handed_without_answer().await;
    *client.refuse.lock().unwrap() = true;
    *client.refusal.lock().unwrap() = Some(ViewRefusal::StalePart {
        mid: "old".into(),
        part: "p".into(),
    });
    // What the next notice does first while `reoffer_pending` is set.
    session.offer_unconfirmed_again(&client).await;
    assert_eq!(offers_of(&client, view.version), 2);
    assert!(session.unconfirmed.is_empty(), "the refusal rolls it back");
    assert_eq!(session.queued, queued_refusal_parts());
    assert_eq!(
        session.failed_parts,
        [("old".into(), "p".into())].into(),
        "parts the refusal did not name were set aside"
    );
    assert!(
        session.refused_once.is_empty(),
        "queued drops the refusal did not name got a refusal strike: {:?}",
        session.refused_once
    );
}

/// The runner refuses the offer again as not newer than a view it holds
/// that ck-mc never built. On first handover that refusal blames no drop
/// and makes ck-mc's next view newer than the runner's
/// (`publish_recorded`); offered again it should do the same.
#[tokio::test]
#[ignore = "fails: offer_unconfirmed_again treats a StaleVersion refusal naming a newer view as the drops' fault and does not raise ck-mc's version"]
async fn lost_answer_review_an_offer_again_refused_for_a_newer_runner_view_blames_no_drop() {
    let (mut session, client, _, view) = handed_without_answer().await;
    let newer = view.version + 5;
    *client.refuse.lock().unwrap() = true;
    *client.refusal.lock().unwrap() = Some(ViewRefusal::StaleVersion {
        version: view.version,
        latest: newer,
    });
    session.offer_unconfirmed_again(&client).await;
    assert!(session.unconfirmed.is_empty());
    assert!(
        session.failed_parts.is_empty(),
        "a refusal for the runner's newer view set parts aside: {:?}",
        session.failed_parts
    );
    assert!(session.refused_once.is_empty());
    assert!(
        session.version >= newer,
        "the next view would reuse a version the runner already holds: {} < {newer}",
        session.version
    );
}

/// The first `session.apply_view` reached the runner but its answer did not
/// come back, and the client's own resend (it resends a `NotSent` that may
/// have been forwarded) is answered "not newer than view N", N being this
/// very view. The runner holds the view, as `offer_unconfirmed_again`
/// already concludes from the same answer, so it must not be rolled back.
#[tokio::test]
#[ignore = "fails: publish_recorded rolls back a view the runner answers as already holding (StaleVersion with latest equal to the view's version)"]
async fn lost_answer_review_a_resend_answered_as_already_held_keeps_the_view() {
    let (mut session, client, settings) = refusal_fixture();
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the old outputs and queued drops build a view");
    *client.refuse.lock().unwrap() = true;
    *client.refusal.lock().unwrap() = Some(ViewRefusal::StaleVersion {
        version: view.version,
        latest: view.version,
    });
    session.publish(&client, view.clone()).await;
    assert_eq!(
        session.latest.as_ref(),
        Some(&view),
        "a view the runner says it holds was rolled back"
    );
    assert_eq!(session.unconfirmed.len(), 1);
    assert!(session.unconfirmed[0].accepted);
    assert!(
        session.queued.is_disjoint(&queued_refusal_parts()),
        "the held view's queued drops were queued again: {:?}",
        session.queued
    );
}

/// The cache-bust analyzer in this repository
/// (`packages/plugin/scripts/cache-bust-runner-log.ts`, `parseRunnerDecision`)
/// takes the session and body with `ck-mc: session (\S+): (.*)$` and the
/// cut with `, cut through (.+)\)$`, anchored at the end of the line. The
/// confirmation line of a view whose answer was lost must still give it the
/// cut.
#[tokio::test]
#[ignore = "fails: the confirmation note follows the closing parenthesis, so the analyzer's end-anchored cut pattern no longer matches and it reports the cut as unlogged"]
async fn lost_answer_review_the_cache_bust_analyzer_reads_the_cut_of_a_confirmed_view() {
    let mut logs = capture();
    let (mut session, client, settings) = refusal_fixture();
    let view = session.seal_unchecked(vec![EditOp::Cut {
        through: "msg_cut".into(),
    }]);
    *client.lose_apply_answers.lock().unwrap() = 1;
    assert!(session.publish(&client, view.clone()).await);
    notice_reporting(&mut session, &client, &settings, 1, Some(&view)).await;
    logs.stop();
    let text = logs.text();
    let line = text
        .lines()
        .find(|line| line.contains(&accepted_line(&view)))
        .unwrap_or_else(|| panic!("no acceptance line for view {}: {text}", view.version));
    let body = regex::Regex::new(r"ck-mc: session (\S+): (.*)$")
        .unwrap()
        .captures(line)
        .expect("the analyzer finds the session")[2]
        .to_owned();
    assert!(body.starts_with(&accepted_line(&view)), "{body}");
    let cut = regex::Regex::new(r", cut through (.+)\)$")
        .unwrap()
        .captures(&body)
        .map(|found| found[1].to_owned());
    assert_eq!(
        cut.as_deref(),
        Some("msg_cut"),
        "the analyzer reads no cut from: {line}"
    );
}

/// ck-mc restarts while the view waits. The runner's Setup reports applying
/// it, which confirms it. The view's acceptance line was never written (it
/// is written on confirmation), so Setup's confirmation must write it, once.
#[tokio::test]
#[ignore = "fails: answer_lost is not saved, so a view confirmed after a restart never gets an acceptance line"]
async fn lost_answer_review_a_view_confirmed_after_a_restart_logs_its_acceptance_once() {
    let mut logs = capture();
    let (session, client, settings, view) = handed_without_answer().await;
    let saved = serde_json::from_slice(&serde_json::to_vec(&session.durable()).unwrap()).unwrap();
    let (mut restored, _, route, mut setup, _) = fixture();
    restored.restore(saved);
    assert_eq!(
        restored.unconfirmed.len(),
        1,
        "the view was saved as handed over"
    );
    setup.applied_view = Some(view.applied());
    setup.newest = client.entries.lock().unwrap().last().map(cursor);
    let mut answer = AppliedViewAnswer::new();
    answer.view = Some(view.clone());
    *client.applied.lock().unwrap() = Some(answer);
    let features = restored.features;
    restored
        .setup(&client, &settings, &route, &setup, features)
        .await;
    logs.stop();
    assert!(
        restored.unconfirmed.is_empty(),
        "Setup's report did not confirm the view"
    );
    assert_eq!(
        offers_of(&client, view.version),
        1,
        "a view the runner reports applying was offered again"
    );
    assert_eq!(
        logs.count(&accepted_line(&view)),
        1,
        "the confirmed view's acceptance was not logged once: {}",
        logs.text()
    );
}

/// The runner never received the first handover: its next notice reports no
/// view, and it accepts the view when ck-mc offers it again. It could render
/// the view only from then on, so the confirmation line must not say the
/// view was handed over before that offer.
#[tokio::test]
#[ignore = "fails: the confirmation line states the lost first call's time even when the runner took the view only when it was offered again"]
async fn lost_answer_review_a_view_first_taken_when_offered_again_is_not_dated_before_that() {
    let mut logs = capture();
    let (mut session, client, settings, view) = handed_without_answer().await;
    std::thread::sleep(std::time::Duration::from_millis(50));
    let offered_again = wall_ms();
    notice_reporting(&mut session, &client, &settings, 1, None).await;
    assert_eq!(offers_of(&client, view.version), 2, "offered again");
    assert!(
        session.unconfirmed[0].accepted,
        "the runner accepted the offer"
    );
    notice_reporting(&mut session, &client, &settings, 2, Some(&view)).await;
    logs.stop();
    let text = logs.text();
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| line.contains(&accepted_line(&view)))
        .collect();
    assert_eq!(lines.len(), 1, "{text}");
    // A line without the note says nothing about the handover time.
    if let Some(handed) = lines[0].split("; handed over at ").nth(1) {
        // RFC 3339 times in this one shape sort as text in time order.
        let earliest = crate::upkeep::iso_8601(offered_again);
        assert!(
            handed >= earliest.as_str(),
            "the line dates the handover at {handed}, before the offer the runner took ({earliest})"
        );
    }
}

/// 76% of the 99,000 usable tokens of `fixture`: over the execute
/// threshold (64,350), below the force band (84,150).
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

/// A worker with two large old outputs (`old`/`p`, `old`/`p2`) and three
/// newer ones, whose runner applies view 18 under a current reading below
/// the threshold, with a drop of `old`/`p2` queued afterwards: a current
/// reading at the threshold lands that queued drop in a new view.
async fn under_view_eighteen() -> (Session, Client, Settings, View) {
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

/// Whether ck-mc still counts view `version` as one the runner accepted.
fn still_accepted(session: &Session, version: u64) -> bool {
    session
        .unconfirmed
        .iter()
        .any(|pending| pending.view.version == version && pending.accepted)
}

/// The runner answered that it accepted view 19. View 20's answer is lost,
/// and so is the answer when the next notice offers it again. That notice
/// carries the reading of the request in flight when the runner took view
/// 19: measured under view 18, at 76%. The runner's acceptance of view 19
/// still stands (it set up nothing in between), so the reading is stale and
/// builds no view, as it does when view 20 never existed
/// (`stale_accepted_a_reading_from_before_the_runner_took_the_view_builds_nothing`).
#[tokio::test]
#[ignore = "fails: offering the waiting view again on a notice clears the acceptance of every unconfirmed view, so a reading the accepted view excuses counts and builds a second view"]
async fn lost_answer_review_an_offer_again_without_answer_keeps_an_older_views_acceptance() {
    let (mut session, client, settings, eighteen) = under_view_eighteen().await;
    let nineteen = session.seal_unchecked(Vec::new());
    assert!(session.publish(&client, nineteen).await);
    assert!(still_accepted(&session, 19));
    let twenty = session.seal_unchecked(Vec::new());
    assert_eq!(twenty.version, 20);
    *client.lose_apply_answers.lock().unwrap() = 2;
    assert!(session.publish(&client, twenty).await);

    let request = reading(&session, &client, 2, HIGH, 18, &eighteen);
    session.notice(&client, &settings, request).await;
    assert_eq!(offers_of(&client, 20), 2, "view 20 was offered again");
    assert!(
        still_accepted(&session, 19),
        "the runner's acceptance of view 19 was forgotten"
    );
    assert!(session.reading_stale, "the in-flight reading counted");
    let built: Vec<u64> = offered(&client).iter().map(|view| view.version).collect();
    assert!(
        built.iter().all(|version| *version <= 20),
        "a reading from before the runner took view 19 built another view: {built:?}"
    );
}
