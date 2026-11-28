//! What happens when another writer deletes or edits, in `context.db`, a
//! summary whose text the session no longer holds in memory.
//!
//! A session keeps every summary's index entry, but the full row only of the
//! summaries newer than the baselines it may still render `m[1]` against.
//! Every other row is read back from `context.db` when it is needed: by a
//! fold, which renders `m[0]` again, and by a summary run, which shows some
//! earlier summaries to the summarizer as references. Before the index, both
//! read the rows the session had loaded into memory, so a later change to
//! `context.db` reached neither until a restart loaded the rows again.

use super::head_bytes_tests::{add_summary, execute, head};
use super::*;

use crate::summary::prompt::ReferenceCompartment;

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

/// A head whose baseline shows summaries 1-3 and whose `m[1]` shows summary
/// 4: the session holds summary 4's row and has let the other three go.
fn released(label: &str) -> (std::path::PathBuf, Session, Settings) {
    let dir = scratch(label);
    let (mut session, settings) = head(&dir);
    build(&mut session, &settings).expect("the first render");
    publish(&mut session, 4, "Newer work on the reader.");
    build(&mut session, &settings).expect("m[1] shows summary 4");
    assert_eq!(session.summaries.held(), 1, "summaries 1-3 are let go");
    (dir, session, settings)
}

/// The references a summary run over messages 17-39 shows, read the way
/// `summary::run::run` reads them from the request the session hands it.
fn run_references(
    session: &mut Session,
    settings: &Settings,
) -> Result<Vec<ReferenceCompartment>, String> {
    let request = session.begin_summary(settings, 17, 40, false, false);
    request_references(session, &request)
}

/// The references `request` shows, read as `summary::run::run` reads them:
/// from the request's own copy of the summaries, then from `context.db`.
fn request_references(
    session: &Session,
    request: &crate::summary::run::Request,
) -> Result<Vec<ReferenceCompartment>, String> {
    let prompts =
        crate::summary::prompts::SummaryPrompts::for_context(request.memory_context.as_ref())
            .unwrap();
    let db = session.db.clone().unwrap();
    crate::summary::fit::references(
        &request.summaries,
        &prompts,
        &request.session.session,
        request.from,
        Some((
            &db,
            request.session.harness.as_str(),
            request.session.session.as_str(),
        )),
    )
}

/// Another writer deletes summary 2, which only `m[0]` shows and whose text
/// the session let go. A fold then can't read it back, and the head is kept
/// as shown. Nothing reloads the index, so the same read fails on every
/// later pass: the due fold never lands and a summary published afterwards
/// never reaches the head, until a restart. Before the index the fold
/// rendered from the rows in memory and the session went on. However the
/// fold treats the missing summary, the head must not stay frozen.
#[test]
fn a_due_fold_lands_after_another_writer_deletes_a_summary_the_session_let_go() {
    let (dir, mut session, settings) = released("review-deleted-fold");
    execute(&session, "DELETE FROM compartments WHERE sequence = 2;");
    // A fold is due, as after a model change.
    session.fold_due = true;
    build(&mut session, &settings);
    publish(&mut session, 5, "Newer work on the writer.");
    for _ in 0..3 {
        build(&mut session, &settings);
    }
    let head = format!(
        "{}\n{}",
        shown(&session, head::M0_ID),
        shown(&session, head::M1_ID)
    );
    assert!(
        !session.fold_due && head.contains("Summary 5: Newer work on the writer."),
        "the due fold never landed (fold_due {}) and summary 5 never reached the head:\n{head}",
        session.fold_due
    );
    drop(session);
    std::fs::remove_dir_all(dir).unwrap();
}

/// A summary run shows the newest summaries as references. Summary 2 is
/// among them, and another writer deleted its row after the session let its
/// text go. Reading the references then fails, and so does the run, before
/// any model is asked; the next run picks the same references and fails the
/// same way, until a restart. Before the index the run showed the row the
/// session held. However the run treats the missing summary, it must still
/// build its prompt.
#[test]
fn a_summary_run_builds_its_references_after_another_writer_deletes_one() {
    let (dir, mut session, settings) = released("review-deleted-reference");
    let prompts =
        crate::summary::prompts::SummaryPrompts::for_context(session.memory_context.as_ref())
            .unwrap();
    let chosen = crate::summary::fit::chosen_references(&session.summaries, &prompts, "s1", 17);
    assert!(chosen.contains(&1), "summary 2 is among the references");
    execute(&session, "DELETE FROM compartments WHERE sequence = 2;");
    let read = run_references(&mut session, &settings);
    assert!(
        read.is_ok(),
        "a deleted reference stops every summary run: {read:?}"
    );
    drop(session);
    std::fs::remove_dir_all(dir).unwrap();
}

/// Another writer edits summary 2 after the session let its text go. The
/// next summary run reads its reference from `context.db` and shows the
/// summarizer the edited text. Before the index the run showed the row the
/// session had loaded. Showing the current text is intended: references are
/// context for the summarizer, not part of a cached prompt, and a reference
/// shows what `context.db` holds now, as the next fold's `m[0]` does. Which
/// summaries are shown is still chosen on the index entries the session
/// loaded (importance, and whether each has content), so an edit to those
/// reaches the choice only when the summaries are next loaded; that is fine
/// too.
#[test]
fn a_summary_run_shows_its_references_as_context_db_holds_them_now() {
    let (dir, mut session, settings) = released("review-edited-reference");
    // What the run showed before the index: the references chosen among
    // every row the session had loaded, as `fit` chose them then.
    let loaded: Vec<ReferenceCompartment> = session
        .summary_rows()
        .unwrap()
        .iter()
        .map(ReferenceCompartment::from)
        .collect();
    let prompts =
        crate::summary::prompts::SummaryPrompts::for_context(session.memory_context.as_ref())
            .unwrap();
    let seeds =
        crate::summary::prompt::select_seeds(&prompts.seeds, "s1", 17, prompts.seeds_per_call);
    let shown_by_base =
        crate::summary::prompt::select_session_references(&loaded, &seeds, "s1", 17);
    assert!(
        shown_by_base
            .iter()
            .any(|reference| reference.title == "Work 2"),
        "summary 2 is among the references"
    );
    execute(
        &session,
        "UPDATE compartments SET title = 'Edited elsewhere', content = 'Edited elsewhere.',
            p1 = 'Edited elsewhere.' WHERE sequence = 2;",
    );
    let read = run_references(&mut session, &settings).unwrap();
    let edited: Vec<ReferenceCompartment> = shown_by_base
        .into_iter()
        .map(|reference| {
            if reference.title == "Work 2" {
                ReferenceCompartment {
                    title: "Edited elsewhere".into(),
                    content: "Edited elsewhere.".into(),
                    p1: Some("Edited elsewhere.".into()),
                    ..reference
                }
            } else {
                reference
            }
        })
        .collect();
    assert_eq!(
        read, edited,
        "the same references, summary 2 as context.db holds it now"
    );
    drop(session);
    std::fs::remove_dir_all(dir).unwrap();
}

/// A revert deletes the summaries it reaches from `context.db` and
/// truncates the session's index in the same step, but a summary run already
/// under way keeps the index it was started with. When the revert reaches a
/// summary whose text the session had let go, the run can no longer read
/// that reference: it ends as a failed summary, which counts a failure and
/// starts the failure backoff (`Drain::record_failure`). Before the index
/// the run showed the rows it was handed, finished, and its summaries were
/// discarded at publication because their messages were gone.
#[test]
fn a_summary_run_under_way_reads_its_references_after_a_revert_reaches_them() {
    let (dir, mut session, settings) = released("review-reverted-reference");
    let request = session.begin_summary(&settings, 17, 40, false, false);
    // Message 6 is inside summary 2 (messages 5-8): summaries 2-4 go.
    session.forget_summaries_from(6);
    assert_eq!(session.summaries.len(), 1);
    let read = request_references(&session, &request);
    assert!(
        read.is_ok(),
        "a revert during a run turns the run into a failed summary: {read:?}"
    );
    drop(session);
    std::fs::remove_dir_all(dir).unwrap();
}
