//! Review witnesses for the dated summary headings of the history head.
//! Each test states the rule it checks.

use super::head_bytes_tests::execute;
use super::*;
use crate::summary::head;

/// 2026-03-01T00:00:00Z.
const DAY0: u64 = 1_772_323_200_000;
/// 2026-04-20T00:00:00Z, seven weeks later.
const LATER: u64 = DAY0 + 50 * 86_400_000;
const EIGHT_HOURS: u64 = 8 * 3_600_000;

/// When message `n` of the first branch was written: every eight hours from
/// `DAY0`, so the four messages of summary 4 (13-16) span 2026-03-05→06.
fn time_of(n: u64) -> u64 {
    DAY0 + (n - 1) * EIGHT_HOURS
}

/// An index entry for message `n`, named `mid`, written at `at`.
fn written(n: u64, mid: &str, at: u64) -> Entry {
    let mut entry = text(n, mid);
    entry.written_at = at;
    entry
}

/// [`super::head_bytes_tests::head`] with sixty messages written every
/// eight hours from `DAY0`, and a `sessions.db` that keeps the times of the
/// messages the index lets go.
fn timed_head(dir: &std::path::Path) -> (Session, Settings) {
    let (mut session, settings) = super::head_bytes_tests::head(dir);
    session.index = crate::index::Index::starting_at(1);
    session
        .index
        .extend((1..=60).map(|n| written(n, &format!("m{n}"), time_of(n))));
    session.store = Some(Arc::new(
        crate::store::Store::open(&dir.join("sessions.db")).unwrap(),
    ));
    (session, settings)
}

/// Build a view, accept it, and confirm it as applied.
fn build(session: &mut Session, settings: &Settings) -> Option<View> {
    let (view, _) = session.build(settings, None, false, None);
    if let Some(view) = &view {
        session.accept(view.clone());
        session.settle_unconfirmed(
            Some(&AppliedView::new(view.version, view.checksum.clone())),
            &[],
        );
    }
    view
}

/// Store summary `sequence` over messages `4k-3..=4k`, whose first and last
/// messages are named `{prefix}{n}`, and publish it for the next build as a
/// summarizer run does.
fn publish(session: &mut Session, sequence: i64, prefix: &str, body: &str) {
    let (start, end) = (sequence * 4 - 3, sequence * 4);
    execute(
        session,
        &format!(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message,
                start_message_id, end_message_id, title, content, p1, created_at, harness)
             VALUES ('s1', {sequence}, {start}, {end}, '{prefix}{start}', '{prefix}{end}',
                'Work {sequence}', '{body}', '{body}', {sequence}, 'mock');"
        ),
    );
    session.load_summaries();
    session.summary_unshown = true;
}

/// The text of the inserted message `id` the latest view shows.
fn shown(session: &Session, id: &str) -> String {
    session
        .latest
        .as_ref()
        .unwrap()
        .edits
        .iter()
        .find_map(|edit| match &edit.op {
            EditOp::Insert { message, .. } if message.id == id => Some(message.texts.join("\n")),
            _ => None,
        })
        .unwrap()
}

/// Rule: a summary's heading shows the days its own first and last message
/// were written. `m[1]` keeps the days it recorded for each summary it shows
/// (`Baseline::newer_days`), under the summary's sequence number. A revert
/// forgets the summaries from the reverted message on, and the summarizer
/// numbers the next one after the last left, so the new branch's first
/// summary takes the number the forgotten one had. When no rebuild that
/// drops the forgotten summary from `m[1]` lands in between, the baseline
/// still holds the forgotten one's days under that number, and the new
/// summary must not inherit them. Here that rebuild's view is undelivered:
/// the runner asked for a view on a request (a ride) and ck-mc's answer
/// missed the request's deadline (`ride_undelivered`), so the session goes
/// back to the baseline that still records summary 4's old days.
#[test]
fn a_summary_written_again_at_a_reverted_sequence_shows_its_own_days() {
    let dir = scratch("head-dates-review-reverted");
    let (mut session, settings) = timed_head(&dir);
    build(&mut session, &settings).expect("the first render");
    publish(&mut session, 4, "m", "Work on the parser.");
    build(&mut session, &settings).expect("m[1] shows summary 4");
    let m1 = shown(&session, head::M1_ID);
    assert!(m1.contains("## 13-16 · 2026-03-05→06 · Work 4"), "{m1}");

    // The person reverts to before message 13. Summary 4 is forgotten, and
    // the host writes a new branch from there seven weeks later.
    session.invalidate_transcript_from(13);
    assert_eq!(session.cut, Some(12));
    session
        .index
        .extend(std::iter::once(written(12, "m12", time_of(12))).chain(
            (13..=60).map(|n| written(n, &format!("r{n}"), LATER + (n - 13) * EIGHT_HOURS)),
        ));
    session.index_ready = true;

    // The view that takes summary 4 out of `m[1]` is undelivered.
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("m[1] drops the forgotten summary");
    assert!(!view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Insert { message, .. } if message.id == head::M1_ID
            && message.texts.join("\n").contains("## 13-16"))));
    session.accept(view.clone());
    session.ride_undelivered(view.version);

    // The new branch's first summary, numbered as the forgotten one was.
    publish(&mut session, 4, "r", "Work on the new branch.");
    build(&mut session, &settings).expect("m[1] shows the new summary 4");
    let m1 = shown(&session, head::M1_ID);
    assert!(
        m1.contains("Work on the new branch."),
        "m[1] shows the new summary: {m1}"
    );
    assert!(
        m1.contains("## 13-16 · 2026-04-20→21 · Work 4"),
        "the new summary 4 covers r13-r16, written 2026-04-20→21: {m1}"
    );
    drop(session);
    std::fs::remove_dir_all(dir).unwrap();
}
