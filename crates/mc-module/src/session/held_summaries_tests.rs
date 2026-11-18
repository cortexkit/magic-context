//! The session keeps every summary's index entry, and full rows only for the
//! summaries newer than every baseline it may still render `m[1]` against.
//! A fold reads the others from `context.db`; a refresh renders the newer
//! ones from memory, byte for byte as before; a read that fails while a view
//! is built keeps the head as shown. Its baselines share one `m[0]` text,
//! after a restart too.

use super::head_bytes_tests::{add_summary, execute, head};
use super::*;

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

/// The text the latest view inserts as the head message `id`.
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

/// Publish summary `sequence` the way a summarizer run does: stored in
/// `context.db`, then appended to the session's list.
fn publish(session: &mut Session, sequence: i64, body: &str) {
    add_summary(session, sequence, body);
    let row = session
        .db
        .as_ref()
        .unwrap()
        .compartments("mock", "s1")
        .unwrap()
        .into_iter()
        .find(|row| row.sequence == sequence)
        .unwrap();
    session.summaries.extend([row]);
    session.summary_unshown = true;
}

#[test]
fn only_summaries_newer_than_the_baseline_stay_in_memory() {
    let dir = scratch("held-summaries");
    let (mut session, settings) = head(&dir);
    assert_eq!(session.summaries.held(), 3, "loading holds every row");
    build(&mut session, &settings).expect("the first render");
    publish(&mut session, 4, "Newer work on the reader.");
    let revision = session.summaries.revision();
    build(&mut session, &settings).expect("m[1] shows summary 4");
    // The fold's baseline shows 1-3; m[1] shows 4 from memory.
    assert_eq!(session.summaries.len(), 4);
    assert_eq!(session.summaries.held(), 1);
    assert_eq!(
        session.summaries.revision(),
        revision,
        "letting text go changes no summary"
    );
    assert!(shown(&session, head::M1_ID).contains("Summary 4: Newer work on the reader."));

    // A restart restores the baseline, and holds only what it needs.
    let store = crate::store::Store::open(&dir.join("mode3.db")).unwrap();
    store.save(&session.key, &session.durable()).unwrap();
    let (mut restored, _, _, _, _) = fixture();
    restored.db = session.db.clone();
    restored.features.summarizer = true;
    restored.load_summaries();
    assert_eq!(restored.summaries.held(), 4);
    restored.restore(store.load(&session.key).unwrap());
    assert_eq!(restored.summaries.held(), 1);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_refresh_shows_what_it_showed_and_a_fold_reads_older_text_from_context_db() {
    let dir = scratch("held-summaries-bytes");
    let (mut session, settings) = head(&dir);
    build(&mut session, &settings).expect("the first render");
    publish(&mut session, 4, "Newer work on the reader.");
    build(&mut session, &settings).expect("m[1] shows summary 4");
    let m1 = shown(&session, head::M1_ID);
    // The fixture writes message n at n milliseconds after the epoch.
    assert!(m1.contains("## 13-16 · 1970-01-01 · Work 4"), "{m1}");

    // Another writer edits summary 4, which `m[1]` shows, and summary 1,
    // which only `m[0]` shows.
    execute(
        &session,
        "UPDATE compartments SET title='Edited title '||sequence, content='Edited '||sequence,
            p1='Edited '||sequence WHERE sequence IN (1, 4);",
    );
    publish(&mut session, 5, "Newer work on the writer.");
    build(&mut session, &settings).expect("m[1] shows summary 5 too");
    let five = session.summary_rows().unwrap().pop().unwrap();
    // Headed with the days `m[1]` recorded for it.
    let days = session
        .baseline
        .as_ref()
        .unwrap()
        .newer_days
        .as_ref()
        .unwrap()[&5]
        .clone()
        .expect("summary 5's messages have times");
    let mut five = crate::summary::render::DecayRenderCompartment::from(&five);
    five.start_date = Some(days.start);
    five.end_date = Some(days.end);
    let five = crate::summary::render::render_compartment_at_tier(&five, 1);
    assert_eq!(
        shown(&session, head::M1_ID),
        m1.replace(
            "\n</new-compartments>",
            &format!("\n\n{five}\n</new-compartments>")
        ),
        "a refresh keeps what m[1] showed, byte for byte"
    );

    // A fold renders m[0] again: summaries the session no longer holds come
    // from context.db as it is now, the ones m[1] showed as it showed them.
    session.fold_due = true;
    build(&mut session, &settings).expect("a fold");
    let m0 = shown(&session, head::M0_ID);
    assert!(m0.contains("## 1-4 · Edited title 1"), "{m0}");
    assert!(m0.contains("## 13-16 · Work 4"), "{m0}");
    std::fs::remove_dir_all(dir).unwrap();
}

/// A fold whose read of `context.db` fails keeps the head as shown, and
/// the next pass reads again.
#[test]
fn a_fold_whose_summaries_cannot_be_read_keeps_the_head_as_shown() {
    let dir = scratch("held-summaries-unreadable");
    let (mut session, settings) = head(&dir);
    build(&mut session, &settings).expect("the first render");
    publish(&mut session, 4, "Newer work on the reader.");
    build(&mut session, &settings).expect("m[1] shows summary 4");
    let (m0, m1) = (shown(&session, head::M0_ID), shown(&session, head::M1_ID));
    // Summaries 1-3 are no longer held, and their table can't be read.
    execute(
        &session,
        "ALTER TABLE compartments RENAME TO compartments_away;",
    );
    session.fold_due = true;
    let (ops, log) = crate::test_log::logged(|| session.render_head(&settings));
    assert!(session.next_baseline.is_none(), "no new baseline");
    let texts: Vec<String> = ops
        .iter()
        .filter_map(|op| match op {
            EditOp::Insert { message, .. } => Some(message.texts.join("\n")),
            _ => None,
        })
        .collect();
    assert_eq!(texts, [m0, m1]);
    assert!(
        log.contains("history head kept as shown, reading summaries: "),
        "{log}"
    );
    assert!(session.summaries_missing.is_none(), "nothing to reload");

    execute(
        &session,
        "ALTER TABLE compartments_away RENAME TO compartments;",
    );
    build(&mut session, &settings).expect("the fold lands");
    assert!(!session.fold_due);
    assert!(shown(&session, head::M0_ID).contains("## 13-16 · Work 4"));
    std::fs::remove_dir_all(dir).unwrap();
}

/// Another writer deletes the newest summary after the session let its
/// text go. The session reads its summaries from `context.db` again: the
/// cut moves back to where they now end, the transcript is read again from
/// there, and the next view moves the cut back and folds, keeping the
/// earlier views' edits. It is the one rebuild the deletion causes.
#[test]
fn the_newest_summary_deleted_elsewhere_moves_the_cut_back_and_keeps_earlier_edits() {
    let dir = scratch("held-summaries-newest-deleted");
    let (mut session, settings) = head(&dir);
    build(&mut session, &settings).expect("the first render");
    publish(&mut session, 4, "Newer work on the reader.");
    build(&mut session, &settings).expect("m[1] shows summary 4");
    session.fold_due = true;
    build(&mut session, &settings).expect("a fold takes summary 4 into m[0]");
    assert_eq!(session.cut, Some(16));
    // An earlier edit every later view carries.
    let dropped = EditOp::Drop {
        mid: "m40".into(),
        part: Some("p".into()),
    };
    let view = session.seal_unchecked(vec![dropped.clone()]);
    session.accept(view.clone());
    session.settle_unconfirmed(
        Some(&AppliedView::new(view.version, view.checksum.clone())),
        &[],
    );

    execute(&session, "DELETE FROM compartments WHERE sequence = 4;");
    session.fold_due = true;
    let (view, log) = crate::test_log::logged(|| build(&mut session, &settings));
    assert!(view.is_none(), "the head stays as shown");
    assert!(
        log.contains("history head kept as shown, summaries [4] are not in context.db"),
        "{log}"
    );
    // The next build reads the summaries again. The cut moves back past
    // what the index holds, so the transcript is read again first.
    let (view, log) = crate::test_log::logged(|| build(&mut session, &settings));
    assert!(view.is_none());
    assert!(
        log.contains("summaries [4] are no longer in context.db"),
        "{log}"
    );
    assert_eq!(session.summaries.len(), 3);
    assert_eq!(session.cut, Some(12));
    assert!(!session.index_ready);
    // The transcript from the cut on, as the next notice reads it.
    session
        .index
        .extend((12..=60).map(|n| text(n, &format!("m{n}"))));
    session.index_ready = true;
    let view = build(&mut session, &settings).expect("the view that moves the cut back");
    assert!(
        view.edits.iter().any(|edit| edit.op == dropped),
        "the earlier drop stays"
    );
    assert!(view.edits.iter().any(|edit| edit.op
        == EditOp::Cut {
            through: "m12".into()
        }));
    assert!(!session.fold_due);
    let m0 = shown(&session, head::M0_ID);
    assert!(
        m0.contains("## 9-12 · Work 3") && !m0.contains("Work 4"),
        "{m0}"
    );
    assert!(
        build(&mut session, &settings).is_none(),
        "nothing else rebuilds"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// After a restart, the session's baseline and an unconfirmed view's
/// before-state share one `m[0]` text, as they did before it.
#[test]
fn a_restore_keeps_one_copy_of_the_head_text() {
    let dir = scratch("held-summaries-m0");
    let (mut session, settings) = head(&dir);
    build(&mut session, &settings).expect("the first render");
    publish(&mut session, 4, "Newer work on the reader.");
    // A view that refreshes m[1], not yet confirmed: its before-state keeps
    // the baseline it replaced, with the same m[0].
    let (view, _) = session.build(&settings, None, false, None);
    session.accept(view.expect("m[1] shows summary 4"));
    let before = session.unconfirmed[0].before.baseline.clone().unwrap();
    let current = session.baseline.clone().unwrap();
    assert!(!Arc::ptr_eq(&before, &current));
    assert!(Arc::ptr_eq(&before.m0, &current.m0));

    let store = crate::store::Store::open(&dir.join("mode3.db")).unwrap();
    store.save(&session.key, &session.durable()).unwrap();
    let (mut restored, _, _, _, _) = fixture();
    restored.db = session.db.clone();
    restored.features.summarizer = true;
    restored.load_summaries();
    restored.restore(store.load(&session.key).unwrap());
    let before = restored.unconfirmed[0].before.baseline.clone().unwrap();
    let current = restored.baseline.clone().unwrap();
    assert_eq!(before.m0, current.m0);
    assert!(Arc::ptr_eq(&before.m0, &current.m0), "one copy of m[0]");
    std::fs::remove_dir_all(dir).unwrap();
}

/// How long a fold takes to read the text of 3,700 summaries back from
/// `context.db`, about as many as the largest head measured holds, with
/// tiers of the measured average sizes. It prints the times; run it with
/// `--release --ignored --nocapture` for numbers worth comparing.
#[test]
#[ignore = "a measurement; run it explicitly"]
fn a_fold_reads_3700_summaries_back() {
    const SUMMARIES: i64 = 3_700;
    let dir = scratch("held-summaries-3700");
    let (mut session, _, _, _, settings) = fixture();
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    session.db = Some(Arc::new(db));
    session.features.summarizer = true;
    let words =
        "Traced the notice through the summary due check and kept the cached prefix stable. ";
    session.db.as_ref().unwrap().with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        for sequence in 1..=SUMMARIES {
            let (start, end) = (sequence * 4 - 3, sequence * 4);
            let p1 = format!("{sequence}: {}", words.repeat(28));
            tx.execute(
                "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, created_at, harness) VALUES ('s1', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10, ?11, ?1, 'mock')",
                rusqlite::params![
                    sequence,
                    start,
                    end,
                    format!("m{start}"),
                    format!("m{end}"),
                    format!("Work {sequence} on the reader and the writer"),
                    p1,
                    words.repeat(10),
                    words.repeat(3),
                    words,
                    30 + sequence * 7 % 50,
                ],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    });
    session.load_summaries();
    // The first render folds every summary into the baseline.
    session.render_head(&settings);
    session.baseline = session.next_baseline.take();
    let from_memory = session.baseline.as_ref().unwrap().m0.clone();
    assert_eq!(session.summaries.held(), SUMMARIES as usize);
    // The next render lets their text go: the baseline shows them all.
    session.fold_due = true;
    let started = std::time::Instant::now();
    session.render_head(&settings);
    let first_fold = started.elapsed();
    assert_eq!(session.summaries.held(), 0);
    let base = session.next_baseline.clone().expect("the fold renders");
    assert_eq!(base.through_sequence, SUMMARIES);
    assert_eq!(base.m0, from_memory, "text read back renders the same m[0]");

    let median = |mut runs: Vec<std::time::Duration>| {
        runs.sort();
        runs[runs.len() / 2]
    };
    let loads = median(
        (0..7)
            .map(|_| {
                let started = std::time::Instant::now();
                let rows = session.summary_rows().unwrap();
                assert_eq!(rows.len(), SUMMARIES as usize);
                started.elapsed()
            })
            .collect(),
    );
    let folds = median(
        (0..5)
            .map(|_| {
                session.fold_due = true;
                let started = std::time::Instant::now();
                session.render_head(&settings);
                let elapsed = started.elapsed();
                assert_eq!(session.next_baseline.as_ref().unwrap().m0, base.m0);
                elapsed
            })
            .collect(),
    );
    println!(
        "FOLD_LOAD summaries={SUMMARIES} load_median_ms={:.1} fold_median_ms={:.1} first_released_fold_ms={:.1}",
        loads.as_secs_f64() * 1e3,
        folds.as_secs_f64() * 1e3,
        first_fold.as_secs_f64() * 1e3,
    );
    std::fs::remove_dir_all(dir).unwrap();
}
