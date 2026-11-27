//! Summary headings in the history head carry the days their first and
//! last message were written, and gaining them never rewrites bytes the
//! provider already caches: `m[0]` gets them only when it folds, `m[1]`
//! only when the summaries it shows change, and a session whose saved head
//! has none keeps it byte for byte on any other rebuild.

use super::head_bytes_tests::{add_summary, execute};
use super::*;
use crate::summary::head;

/// 2026-03-01T00:00:00Z.
const DAY0: u64 = 1_772_323_200_000;
const EIGHT_HOURS: u64 = 8 * 3_600_000;

/// When message `n` was written: every eight hours from `DAY0`, so each
/// four-message summary spans two days.
fn time_of(n: u64) -> u64 {
    DAY0 + (n - 1) * EIGHT_HOURS
}

/// [`super::head_bytes_tests::head`], with every message written at
/// `written_at(n)` and a `sessions.db` that keeps the times of messages the
/// index lets go.
fn timed_head(dir: &std::path::Path, written_at: impl Fn(u64) -> u64) -> (Session, Settings) {
    let (mut session, settings) = super::head_bytes_tests::head(dir);
    session.index = crate::index::Index::starting_at(1);
    session.index.extend((1..=60).map(|n| {
        let mut entry = text(n, &format!("m{n}"));
        entry.written_at = written_at(n);
        entry
    }));
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

/// Publish summary `sequence` (messages `4k-3..=4k`) for the next build.
fn publish(session: &mut Session, sequence: i64) {
    add_summary(session, sequence, "More work on the parser.");
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

/// The history head's edits a view carries, `m[0]` then `m[1]`.
fn head_ops(view: &View) -> Vec<EditOp> {
    view.edits
        .iter()
        .filter(|edit| head::is_head(&edit.op))
        .map(|edit| edit.op.clone())
        .collect()
}

/// A session whose saved head was rendered before headings carried dates:
/// three summaries in `m[0]` and summary 4 in `m[1]`, none dated, and a
/// baseline with no record of dates, as that build saved it. It then
/// restarts, so nothing it kept in memory survives, and from then on every
/// message's time is known, from the message search index.
fn undated_head(dir: &std::path::Path) -> (Session, Settings) {
    let (mut session, settings) = timed_head(dir, |_| 0);
    build(&mut session, &settings).unwrap();
    publish(&mut session, 4);
    build(&mut session, &settings).unwrap();
    assert!(
        shown(&session, head::M1_ID).contains("## 13-16 · Work 4"),
        "{}",
        shown(&session, head::M1_ID)
    );
    // The earlier build's saved baseline has no `newer_days`; it loads as
    // `None` and saves as the same bytes.
    let mut saved = serde_json::to_value(session.baseline.as_deref().unwrap()).unwrap();
    saved.as_object_mut().unwrap().remove("newer_days");
    let legacy: Baseline = serde_json::from_value(saved.clone()).unwrap();
    assert_eq!(legacy.newer_days, None);
    assert_eq!(serde_json::to_value(&legacy).unwrap(), saved);
    session.baseline = Some(Arc::new(legacy));
    session.head_summaries = None;
    let rows: Vec<String> = (1..=60)
        .map(|n| format!("('s1', {n}, {n}, {})", time_of(n)))
        .collect();
    execute(
        &session,
        &format!(
            "INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms) VALUES {};",
            rows.join(", ")
        ),
    );
    (session, settings)
}

#[test]
fn a_rebuild_that_only_lands_drops_keeps_an_undated_head_byte_for_byte() {
    let dir = scratch("head-dates-drops");
    let (mut session, settings) = undated_head(&dir);
    let served = head_ops(session.latest.as_ref().unwrap());
    session.queued.insert(("m40".into(), "p".into()));
    let view = build(&mut session, &settings).expect("the drop lands");
    assert!(
        view.edits.iter().any(|edit| matches!(&edit.op,
            EditOp::Replace { mid, .. } if mid == "m40")),
        "{view:?}"
    );
    assert_eq!(head_ops(&view), served);
    assert_eq!(session.baseline.as_ref().unwrap().newer_days, None);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_history_refresh_dates_m1s_summaries_and_keeps_m0() {
    let dir = scratch("head-dates-refresh");
    let (mut session, settings) = undated_head(&dir);
    let m0 = shown(&session, head::M0_ID);
    publish(&mut session, 5);
    build(&mut session, &settings).unwrap();
    assert_eq!(shown(&session, head::M0_ID), m0);
    assert!(m0.contains("## 1-4 · Work 1"), "{m0}");
    let m1 = shown(&session, head::M1_ID);
    assert!(m1.contains("## 13-16 · 2026-03-05→06 · Work 4"), "{m1}");
    assert!(m1.contains("## 17-20 · 2026-03-06→07 · Work 5"), "{m1}");
    // The days are kept with the baseline: a later rebuild for anything
    // else shows the same `m[1]`.
    session.head_summaries = None;
    session.queued.insert(("m40".into(), "p".into()));
    build(&mut session, &settings).unwrap();
    assert_eq!(shown(&session, head::M1_ID), m1);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_fold_dates_every_summary() {
    let dir = scratch("head-dates-fold");
    let (mut session, settings) = undated_head(&dir);
    publish(&mut session, 5);
    build(&mut session, &settings).unwrap();
    session.fold_due = true;
    build(&mut session, &settings).unwrap();
    let m0 = shown(&session, head::M0_ID);
    for heading in [
        "## 1-4 · 2026-03-01→02 · Work 1",
        "## 5-8 · 2026-03-02→03 · Work 2",
        "## 9-12 · 2026-03-03→04 · Work 3",
        "## 13-16 · 2026-03-05→06 · Work 4",
        "## 17-20 · 2026-03-06→07 · Work 5",
    ] {
        assert!(m0.contains(heading), "{heading}: {m0}");
    }
    assert_eq!(shown(&session, head::M1_ID), head::M1_EMPTY);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_fold_finds_times_the_index_let_go_and_m1_dates_newer_summaries() {
    // Every time comes from the transcript index, or, once a cut lets a
    // message go, from the times the session saved for it.
    let dir = scratch("head-dates-held");
    let (mut session, settings) = timed_head(&dir, time_of);
    build(&mut session, &settings).unwrap();
    let m0 = shown(&session, head::M0_ID);
    assert!(m0.contains("## 1-4 · 2026-03-01→02 · Work 1"), "{m0}");
    assert!(session.index.base() > 1, "the cut let messages go");
    publish(&mut session, 4);
    build(&mut session, &settings).unwrap();
    assert_eq!(shown(&session, head::M0_ID), m0);
    let m1 = shown(&session, head::M1_ID);
    assert!(m1.contains("## 13-16 · 2026-03-05→06 · Work 4"), "{m1}");
    session.fold_due = true;
    build(&mut session, &settings).unwrap();
    let m0 = shown(&session, head::M0_ID);
    assert!(m0.contains("## 9-12 · 2026-03-03→04 · Work 3"), "{m0}");
    assert!(m0.contains("## 13-16 · 2026-03-05→06 · Work 4"), "{m0}");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_summary_with_an_unknown_time_shows_no_date() {
    let dir = scratch("head-dates-unknown");
    // Message 8, summary 2's last, has no known time anywhere.
    let (mut session, settings) = timed_head(&dir, |n| if n == 8 { 0 } else { time_of(n) });
    build(&mut session, &settings).unwrap();
    let m0 = shown(&session, head::M0_ID);
    assert!(m0.contains("## 5-8 · Work 2"), "{m0}");
    assert!(m0.contains("## 1-4 · 2026-03-01→02 · Work 1"), "{m0}");
    assert!(m0.contains("## 9-12 · 2026-03-03→04 · Work 3"), "{m0}");
    std::fs::remove_dir_all(dir).unwrap();
}

/// The same session after a restart: its saved state loaded into a new
/// session over the same stores, holding the same view and transcript.
fn restart(session: &Session) -> Session {
    let store = session.store.as_ref().unwrap();
    store.save(&session.key, &session.durable()).unwrap();
    let (mut restored, _, _, _, _) = fixture();
    restored.db = session.db.clone();
    restored.store = session.store.clone();
    restored.features.summarizer = true;
    restored.project = session.project.clone();
    restored.load_summaries();
    restored.restore(store.load(&session.key).unwrap());
    restored.latest = session.latest.clone();
    restored.latest_unknown = false;
    restored.index.extend(session.index.entries().to_vec());
    restored.index_ready = true;
    restored
}

/// When a cut could not save the times of the messages it let go (a failed
/// write to `sessions.db`), the days `m[1]` showed from those times are not
/// carried into `m[0]`: the next full rebuild dates the summary by the
/// nearest timed message the stores hold, and a rebuild after a restart
/// shows the same bytes.
#[test]
fn a_summary_whose_times_were_not_saved_takes_the_approximation_warm_and_cold() {
    let dir = scratch("head-dates-unsaved");
    let (mut session, settings) = timed_head(&dir, time_of);
    build(&mut session, &settings).unwrap();
    publish(&mut session, 4);
    build(&mut session, &settings).unwrap();
    assert!(shown(&session, head::M1_ID).contains("## 13-16 · 2026-03-05→06 · Work 4"));
    // The transcript no longer holds the times, and none were saved.
    let base = session.index.base();
    session.index = crate::index::Index::starting_at(base);
    session.index.extend((base..=60).map(|n| {
        let mut entry = text(n, &format!("m{n}"));
        entry.written_at = 0;
        entry
    }));
    let store = session.store.clone().unwrap();
    store.save_app_index(&session.key, &[], Some(1)).unwrap();
    // Inside summary 4, a message of another day.
    search_rows(&session, &[(14, DAY0 + 20 * 24 * 3_600_000)]);
    session.fold_due = true;
    build(&mut session, &settings).unwrap();
    let warm = shown(&session, head::M0_ID);
    assert!(warm.contains("## 13-16 · 2026-03-21 · Work 4"), "{warm}");
    let mut restored = restart(&session);
    restored.fold_due = true;
    build(&mut restored, &settings);
    assert_eq!(shown(&restored, head::M0_ID), warm);
    std::fs::remove_dir_all(dir).unwrap();
}

/// Rows of the message search index: message `n` written at its time.
fn search_rows(session: &Session, rows: &[(u64, u64)]) {
    let values: Vec<String> = rows
        .iter()
        .map(|(n, at)| format!("('s1', {n}, {n}, {at})"))
        .collect();
    execute(
        session,
        &format!(
            "INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms) VALUES {};",
            values.join(", ")
        ),
    );
}

/// No message keeps its own time: the index has none and nothing was saved.
fn lose_times(session: &mut Session) {
    let base = session.index.base();
    session.index = crate::index::Index::starting_at(base);
    session.index.extend((base..=60).map(|n| {
        let mut entry = text(n, &format!("m{n}"));
        entry.written_at = 0;
        entry
    }));
    session.store = None;
}

/// A boundary message without a time of its own (no text in the search
/// index) takes the nearest timed message's day: the first and last timed
/// message inside the summary, else the nearest earlier, else the next
/// later one, looked up afresh each time.
#[test]
fn a_boundary_without_a_time_takes_the_nearest_timed_message() {
    let dir = scratch("head-dates-nearest");
    let (mut session, settings) = timed_head(&dir, |_| 0);
    search_rows(
        &session,
        &[(2, time_of(2)), (3, time_of(3)), (10, time_of(10))],
    );
    build(&mut session, &settings).unwrap();
    let m0 = shown(&session, head::M0_ID);
    for heading in [
        // Messages 2 and 3, inside.
        "## 1-4 · 2026-03-01 · Work 1",
        // None inside: message 3, the nearest earlier.
        "## 5-8 · 2026-03-01 · Work 2",
        // Message 10 alone.
        "## 9-12 · 2026-03-04 · Work 3",
    ] {
        assert!(m0.contains(heading), "{heading}: {m0}");
    }
    // Nothing found this way is kept: once the index loses those times,
    // the next lookup finds no day.
    execute(&session, "DELETE FROM message_fts_rowid_map;");
    let mut rows: Vec<crate::context_db::StoredCompartment> = (1..=3)
        .map(|sequence| crate::context_db::StoredCompartment {
            sequence,
            start_message: sequence * 4 - 3,
            end_message: sequence * 4,
            start_message_id: format!("m{}", sequence * 4 - 3),
            end_message_id: format!("m{}", sequence * 4),
            ..Default::default()
        })
        .collect();
    session.date_summaries(&mut rows);
    assert!(rows
        .iter()
        .all(|row| row.start_date.is_none() && row.end_date.is_none()));
    std::fs::remove_dir_all(dir).unwrap();

    // Before the session's first timed message: the next later one.
    let dir = scratch("head-dates-next");
    let (mut session, settings) = timed_head(&dir, |_| 0);
    search_rows(&session, &[(6, time_of(6))]);
    build(&mut session, &settings).unwrap();
    let m0 = shown(&session, head::M0_ID);
    for heading in [
        "## 1-4 · 2026-03-02 · Work 1",
        "## 5-8 · 2026-03-02 · Work 2",
        "## 9-12 · 2026-03-02 · Work 3",
    ] {
        assert!(m0.contains(heading), "{heading}: {m0}");
    }
    std::fs::remove_dir_all(dir).unwrap();

    // No timed message anywhere: no date.
    let dir = scratch("head-dates-none");
    let (mut session, settings) = timed_head(&dir, |_| 0);
    build(&mut session, &settings).unwrap();
    let m0 = shown(&session, head::M0_ID);
    assert!(m0.contains("## 1-4 · Work 1"), "{m0}");
    std::fs::remove_dir_all(dir).unwrap();
}

/// A day `m[1]` showed is not carried into `m[0]` at a fold: `m[0]` dates
/// every summary from what the stores hold. With the exact times gone, the
/// nearest timed message's day is shown, and the next full rebuild shows
/// the same day: nothing drifts between rebuilds over the same stores.
#[test]
fn a_day_m1_showed_gives_way_to_the_stores_at_a_fold_and_stays() {
    let dir = scratch("head-dates-recorded-first");
    let (mut session, settings) = timed_head(&dir, time_of);
    build(&mut session, &settings).unwrap();
    publish(&mut session, 4);
    build(&mut session, &settings).unwrap();
    assert!(shown(&session, head::M1_ID).contains("## 13-16 · 2026-03-05→06 · Work 4"));
    lose_times(&mut session);
    // Inside summary 4, a message of another day.
    search_rows(&session, &[(14, DAY0 + 20 * 24 * 3_600_000)]);
    session.fold_due = true;
    build(&mut session, &settings).unwrap();
    let m0 = shown(&session, head::M0_ID);
    assert!(m0.contains("## 13-16 · 2026-03-21 · Work 4"), "{m0}");
    session.fold_due = true;
    build(&mut session, &settings);
    assert_eq!(shown(&session, head::M0_ID), m0);
    std::fs::remove_dir_all(dir).unwrap();
}

/// Days the nearest timed message would give change no bytes until a fold:
/// a head rendered while its summaries had no day keeps them undated on a
/// rebuild that neither folds nor shows newer summaries.
#[test]
fn days_from_the_nearest_message_wait_for_a_fold() {
    let dir = scratch("head-dates-nearest-wait");
    let (mut session, settings) = timed_head(&dir, |_| 0);
    build(&mut session, &settings).unwrap();
    let served = head_ops(session.latest.as_ref().unwrap());
    let m0 = shown(&session, head::M0_ID);
    assert!(m0.contains("## 1-4 · Work 1"), "{m0}");
    // Messages inside every summary gain times; no boundary does.
    search_rows(
        &session,
        &[(2, time_of(2)), (6, time_of(6)), (10, time_of(10))],
    );
    session.queued.insert(("m40".into(), "p".into()));
    let view = build(&mut session, &settings).expect("the drop lands");
    assert_eq!(head_ops(&view), served);
    session.fold_due = true;
    build(&mut session, &settings).unwrap();
    let m0 = shown(&session, head::M0_ID);
    assert!(m0.contains("## 1-4 · 2026-03-01 · Work 1"), "{m0}");
    assert!(m0.contains("## 5-8 · 2026-03-02 · Work 2"), "{m0}");
    std::fs::remove_dir_all(dir).unwrap();
}

/// What dating costs a fold of 3,800 summaries when half of them have no
/// time at either boundary message (only messages inside them do): the
/// first fold after a start, which looks each of those up by the nearest
/// timed message, and a later one, which finds them kept.
#[test]
#[ignore = "a measurement; run with --release --ignored --nocapture"]
fn nearest_message_dating_time() {
    let dir = scratch("head-dates-nearest-time");
    let (session, _) = timed_head(&dir, |_| 0);
    let count = 3_800u64;
    let mut rows = Vec::new();
    for sequence in 1..=count {
        let (start, end) = (sequence * 4 - 3, sequence * 4);
        rows.push((start + 1, time_of(start + 1)));
        rows.push((start + 2, time_of(start + 2)));
        if sequence % 2 == 0 {
            rows.push((start, time_of(start)));
            rows.push((end, time_of(end)));
        }
    }
    for chunk in rows.chunks(2_000) {
        search_rows(&session, chunk);
    }
    let summaries: Vec<crate::context_db::StoredCompartment> = (1..=count as i64)
        .map(|sequence| crate::context_db::StoredCompartment {
            sequence,
            start_message: sequence * 4 - 3,
            end_message: sequence * 4,
            start_message_id: format!("m{}", sequence * 4 - 3),
            end_message_id: format!("m{}", sequence * 4),
            title: format!("Work {sequence}"),
            ..Default::default()
        })
        .collect();
    let timed = |label: &str| {
        let mut dated = summaries.clone();
        let started = std::time::Instant::now();
        session.date_summaries(&mut dated);
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        let undated = dated.iter().filter(|row| row.start_date.is_none()).count();
        println!("DATING {label}: {elapsed:.0} ms for {count} summaries, {undated} undated");
    };
    timed("first fold after a start");
    timed("later fold");
    std::fs::remove_dir_all(dir).unwrap();
}

/// A day found by the nearest timed message is looked up afresh at every
/// full rebuild: when a closer time arrives, a warm rebuild and a rebuild
/// after a restart over the same stores both show the new day, the same
/// bytes.
#[test]
fn an_approximated_day_follows_the_stores_at_every_full_rebuild() {
    let dir = scratch("head-dates-approximated");
    let (mut session, settings) = timed_head(&dir, |_| 0);
    search_rows(&session, &[(3, DAY0)]);
    build(&mut session, &settings).unwrap();
    assert!(shown(&session, head::M0_ID).contains("## 5-8 · 2026-03-01 · Work 2"));
    // A time inside summary 2 arrives; its boundaries stay untimed.
    search_rows(&session, &[(6, DAY0 + 9 * 24 * 3_600_000)]);
    session.fold_due = true;
    build(&mut session, &settings);
    let warm = shown(&session, head::M0_ID);
    assert!(warm.contains("## 5-8 · 2026-03-10 · Work 2"), "{warm}");
    let mut restored = restart(&session);
    assert_eq!(shown(&restored, head::M0_ID), warm);
    restored.fold_due = true;
    build(&mut restored, &settings);
    assert_eq!(shown(&restored, head::M0_ID), warm);
    std::fs::remove_dir_all(dir).unwrap();
}
