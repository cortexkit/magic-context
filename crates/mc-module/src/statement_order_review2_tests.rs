//! Witnesses for a gap between the two places statement order is checked.
//!
//! `Module::notice` and `Module::ride` check a statement's epoch against
//! the epoch of the session's newest Setup (`statement_admitted`, under the
//! `set_up` lock) and only then queue it for the session's worker (`send`,
//! under the `workers` lock). `Module::setup` queues its Setup job first and
//! records its epoch afterwards. Neither pair runs under one lock, and the
//! worker never looks at an epoch. So a statement built under the epoch a
//! Setup replaces, arriving on another route while that Setup is handled
//! (the contract's W3.5 says such statements may arrive at any time, and
//! runners need not drain those routes), can pass the epoch check before
//! the new epoch is recorded and be queued after the new Setup's job. The
//! worker then takes it as a statement of the new epoch.
//!
//! Each test runs that interleaving deterministically, by calling the two
//! halves of `Module::notice` or `Module::ride` itself with the whole of
//! `Module::setup` in between, then states what the contract requires: the
//! foreign statement gives nothing, and the new epoch's own notices are
//! taken.

use super::*;
use tokio::sync::oneshot;

/// The epoch of the Setup the runner replaced, and the one it set up with
/// after restoring the session.
const REPLACED: &str = "replaced-history";
const RESTORED: &str = "restored-history";

/// Conditions built under `epoch` and stamped `stamp`, naming `model`, so
/// the saved conditions show which statement ck-mc last took.
fn stamped(epoch: &str, stamp: u64, model: &str) -> Conditions {
    let mut conditions = conditions(model);
    conditions.statement_epoch = Some(epoch.to_owned());
    conditions.statement_seq = Some(stamp);
    conditions
}

/// A notice of the replaced epoch, numbered 9 (that history had sent eight
/// before it), passes the epoch check just before the restored Setup is
/// recorded and reaches the worker just after the restored Setup's job. The
/// worker takes it, so its number becomes the session's notice count, and
/// the restored epoch's own notices, numbered from 1 again (S3), are all
/// ignored as old (N5) until one is numbered above 9. The contract says a
/// foreign-epoch notice advances nothing, the notice number included.
#[tokio::test]
async fn review2_a_replaced_epochs_notice_queued_behind_the_new_setup_takes_no_notice_number() {
    let f = Fixture::new();
    f.setup(Some(REPLACED));
    assert_eq!(
        f.notice(1, Some(REPLACED), Some(2), "before-restore"),
        NoticeAnswer::Received
    );
    assert_eq!(f.taken_model().await, "before-restore");

    // The first half of `Module::notice`: the epoch is checked while the
    // replaced Setup's epoch is still the one recorded.
    let late = NoticeRequest::new(9, stamped(REPLACED, 50, "replaced-state"));
    assert_eq!(
        f.module
            .statement_admitted(&f.key, "notice", &late.conditions),
        Some(true)
    );
    // The runner's Setup after the restore runs whole in between.
    f.setup(Some(RESTORED));
    // The second half: the notice is queued, now behind the new Setup.
    f.module.send(&f.key, Job::Notice(late)).unwrap();

    for seq in 1..=3 {
        let model = format!("restored-{seq}");
        assert_eq!(
            f.notice(seq, Some(RESTORED), Some(1 + seq), &model),
            NoticeAnswer::Received
        );
        assert_eq!(
            f.taken_model().await,
            model,
            "notice {seq} of the restored epoch was not taken"
        );
    }
}

/// A ride of the replaced epoch, stamped 50 (a runner stamping with its
/// log position, whose restored log is shorter), passes the epoch check
/// before the restored Setup (stamped 1) is recorded and reaches the worker
/// after its job. The worker takes its conditions and raises the held
/// stamp to 50, so every notice the restored epoch stamps below 50 counts
/// as built before a statement ck-mc already took: its signed floor,
/// counts and size reading are not taken, and nothing answers
/// `setup_required` to make the runner repair it. The contract says a
/// foreign-epoch ride gives nothing.
#[tokio::test]
async fn review2_a_replaced_epochs_ride_queued_behind_the_new_setup_sets_no_stamp() {
    let f = Fixture::new();
    f.setup(Some(REPLACED));
    assert_eq!(
        f.notice(1, Some(REPLACED), Some(2), "before-restore"),
        NoticeAnswer::Received
    );
    assert_eq!(f.taken_model().await, "before-restore");

    // The first half of `Module::ride`.
    let late = RideRequest::new(Vec::new(), 1_000, stamped(REPLACED, 50, "replaced-state"));
    assert_eq!(
        f.module
            .statement_admitted(&f.key, "ride", &late.conditions),
        Some(true)
    );
    f.setup(Some(RESTORED));
    // The second half: the ride is queued behind the new Setup, and its
    // answer awaited as `Module::ride` awaits it.
    let (reply, answer) = oneshot::channel();
    f.module.send(&f.key, Job::Ride(late, reply)).unwrap();
    let _ = answer.await;

    for seq in 1..=3 {
        let model = format!("restored-{seq}");
        assert_eq!(
            f.notice(seq, Some(RESTORED), Some(1 + seq), &model),
            NoticeAnswer::Received
        );
        assert_eq!(
            f.taken_model().await,
            model,
            "notice {seq} of the restored epoch was taken as late"
        );
    }
}
