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
/// `written_at(n)` and a `mode3.db` that keeps the times of messages the
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
        crate::store::Store::open(&dir.join("mode3.db")).unwrap(),
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
