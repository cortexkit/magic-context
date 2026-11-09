//! A step that shows no new summary copies no summary attribution: the
//! next baseline, the history head's newer summaries and the apps' token
//! breakdown share the lists an earlier step made. Copying them on each
//! step made a step's cost grow with the number of summaries.

use super::head_bytes_tests::{add_summary, execute, head};
use super::*;

fn publish(session: &mut Session, settings: &Settings) {
    let (view, _) = session.build(settings, None, false, None);
    let view = view.expect("the pass publishes a view");
    session.accept(view.clone());
    session.settle_unconfirmed(Some(&AppliedView::new(view.version, view.checksum)), &[]);
}

#[test]
fn a_rebuild_with_no_new_summary_shares_the_summary_attribution() {
    let dir = scratch("summary-sharing");
    let (mut session, settings) = head(&dir);
    publish(&mut session, &settings);
    add_summary(&session, 4, "Newer work on the reader.");
    session.load_summaries();
    session.summary_unshown = true;
    publish(&mut session, &settings);
    let items = session.baseline.as_ref().unwrap().summary_items.clone();
    assert_eq!(items.len(), 4, "m[1] shows the newer summary");
    let before = session.app_update();

    // `m[1]` changes for a memory alone; the newer summary it still shows
    // is not rendered or counted again.
    execute(
        &session,
        "UPDATE memories SET content='Run the gate first.' WHERE id=1;",
    );
    session.head_stale = true;
    publish(&mut session, &settings);
    assert!(
        session
            .baseline
            .as_ref()
            .unwrap()
            .summary_items
            .same(&items),
        "the rebuild made the summary items again"
    );
    let after = session.app_update();
    assert!(
        after
            .header
            .breakdown
            .shares_summaries(&before.header.breakdown),
        "the breakdown made its summary items again for the new view"
    );

    // A notice that builds no view shares them too.
    session.index.extend([text(61, "m61")]);
    let quiet = session.app_update();
    assert!(!quiet.rows.is_empty());
    assert!(quiet
        .header
        .breakdown
        .shares_summaries(&after.header.breakdown));
    std::fs::remove_dir_all(dir).unwrap();
}
