//! The order of the runner's statements.
//!
//! A runner tells ck-mc about a session in statements: Setup, notices and
//! rides. Each one states the runner state it was built from: its
//! conditions (model, window, output reserve, rules, image acceptance,
//! signed floor, system, tools and notes counts, and the prompt size of the
//! newest measured request) and the view it applies. A notice is sent in
//! the background, so a ride built from newer session state can reach
//! ck-mc first; taken in arrival order, the late notice would put the older
//! state back. A statement built before the runner restored the session, or
//! before a restart or crash recovery that discarded the tail of its log,
//! can even arrive after the Setup that replaced that history. ck-mc
//! declares `compaction-statement-seq/v1`, so the runner marks every
//! statement with two values (compaction contract W3.5): `statement_epoch`,
//! an opaque string the runner mints at every Setup and every notice and
//! ride built under that Setup repeats, and `statement_seq`, a stamp that
//! never decreases within the epoch and is never lower on a statement built
//! from newer state.
//!
//! Whether a notice or ride belongs to the session as ck-mc holds it is
//! decided before anything in it is taken, in two steps.
//!
//! First the epoch, when the statement arrives and before it is queued for
//! the session's worker ([`epoch_admits`], called by
//! [`crate::module::Module`]): the answer to a dropped statement must go
//! back before the worker runs. A statement whose epoch differs from the
//! one the session's Setup named, one with an epoch when that Setup named
//! none or without one when it named one, and one with a stamp but no
//! epoch belong to a history the runner has replaced. They are dropped
//! whole and advance nothing, the notice number included: a dropped notice
//! is answered `setup_required` and a dropped ride refused
//! `unknown_session`, both of which make a live runner set the session up
//! again. The epoch is held in memory only. A runner always sets a session
//! up again after its own restart, and after ck-mc's restart a notice or
//! ride for a session not set up since is answered the same way.
//!
//! Then the stamp, on the worker, before the notice number is checked
//! ([`Session::standing`]). ck-mc holds the highest stamp it took for each
//! session, in memory only.
//!
//! - A Setup states what the session is now, for example after the runner
//!   restored it from a backup, so its epoch and stamp replace the held
//!   ones even when the stamp is lower, and a Setup with neither clears
//!   both: statements are then taken in arrival order, as from a runner
//!   that never stamps.
//! - A notice or ride stamped at or above the held stamp is taken as
//!   always, and raises the held stamp. Equal stamps were built from the
//!   same state, and the later arrival wins.
//! - A notice or ride stamped below it was built strictly before the
//!   statement that set the held stamp. Nothing is taken from it as runner
//!   state: not its conditions, not its applied view. That includes its
//!   prompt size. A statement's reading is the size of the last request
//!   measured when it was built, so a late statement's reading is the one
//!   ck-mc already holds from the newer statement, or an older one, never
//!   a newer one; the contract states the same rule. The staleness rules
//!   for readings assume readings arrive in the order they were measured,
//!   so the late reading enters none of their bookkeeping either. The pass
//!   that follows judges the reading ck-mc holds as a repeat of it would be
//!   judged, and leaves the pressure state (the emergency latch, the
//!   `ctx_keep` request and the summary floor mark) as the last reading
//!   left it. Its applied view confirms or rolls back no view, sets back no
//!   applied version and is never compared with ck-mc's own view. Any
//!   member the contract adds to the conditions later is kept from the
//!   held state as well.
//! - The transcript is not runner state: a late statement's entries are
//!   read and its events (a revert, a view refused at a step boundary) are
//!   acted on, since those arrive only as events. While ck-mc does not
//!   know its own newest view, as after a restart whose read-back failed,
//!   any statement reads the runner's view back; that read is the runner's
//!   current answer, not the late statement's.
//! - A notice or ride without a stamp, from a runner whose Setup named no
//!   epoch, is taken in arrival order, and leaves the held stamp as it is.

use super::*;

/// Whether a notice or ride with `conditions` belongs to the Setup epoch
/// ck-mc holds for its session: `held` is the epoch the session's Setup
/// named, `None` when it named none. Presence must match as well as the
/// value, and a stamp without an epoch is never admitted, whatever ck-mc
/// holds (see the module docs).
pub(crate) fn epoch_admits(held: Option<&str>, conditions: &Conditions) -> bool {
    if conditions.statement_epoch.is_none() && conditions.statement_seq.is_some() {
        return false;
    }
    conditions.statement_epoch.as_deref() == held
}

/// Where a notice or ride stands against the session as ck-mc holds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Standing {
    /// Built from the runner state ck-mc holds, or newer, or not stamped:
    /// taken as always.
    Current,
    /// Built before a statement ck-mc already took: stamped `stamp`, below
    /// the held stamp `held`. Only its transcript is taken.
    Older { stamp: u64, held: u64 },
}

/// What a notice or ride says about the view the runner applies, once its
/// standing is decided.
#[derive(Clone, Copy, Debug)]
pub(super) enum StatedView<'a> {
    /// Taken as the runner's state: the view it applies, or none when the
    /// statement names none.
    Now(Option<&'a AppliedView>),
    /// The statement was built from older runner state than one ck-mc
    /// already took, so it says nothing about the view applied now.
    Older,
}

impl<'a> StatedView<'a> {
    pub(super) fn of(standing: Standing, applied: Option<&'a AppliedView>) -> Self {
        match standing {
            Standing::Current => Self::Now(applied),
            Standing::Older { .. } => Self::Older,
        }
    }
}

impl Session {
    /// Where a notice or ride with `conditions` stands against the session
    /// as ck-mc holds it. Decided before anything in it is taken.
    pub(super) fn standing(&self, conditions: &Conditions) -> Standing {
        match (conditions.statement_seq, self.statement_seq) {
            (Some(stamp), Some(held)) if stamp < held => Standing::Older { stamp, held },
            _ => Standing::Current,
        }
    }

    /// Take a notice's or ride's `conditions` (`kind` names which, for the
    /// log) when it is current. A late statement takes nothing; the caller
    /// also keeps as held the runner state it holds outside the conditions
    /// (the system, tools and notes counts, and the applied view).
    pub(super) fn take_conditions(
        &mut self,
        kind: &str,
        standing: Standing,
        conditions: &Conditions,
    ) {
        self.statement_late = matches!(standing, Standing::Older { .. });
        let Standing::Older { stamp, held } = standing else {
            if let Some(stamp) = conditions.statement_seq {
                self.statement_seq = Some(self.statement_seq.map_or(stamp, |held| held.max(stamp)));
            }
            self.conditions = conditions.clone();
            // The epoch and stamp are held on their own and never saved: the
            // saved conditions stay as they were before either existed.
            self.conditions.statement_epoch = None;
            self.conditions.statement_seq = None;
            return;
        };
        self.late_statements += 1;
        tracing::info!(
            "ck-mc: session {}: {kind} stamped {stamp} was built before the statement stamped {held} that ck-mc already took; keeping the runner state and the reading held, taking only its entries and events",
            self.key.session
        );
    }

    /// Judge the reading ck-mc holds after a late statement, which brought
    /// none: stale when it already was (`was_stale`), or when a repeat of it
    /// would be stale now because a view was built after it, by the same
    /// tests [`Session::judge_reading`] applies. Unlike a reading that
    /// arrives, it leaves the bookkeeping behind those tests as it is.
    pub(super) fn judge_held_reading(&mut self, was_stale: bool, judged: Option<&AppliedView>) {
        self.reading_stale = was_stale || self.held_reading_spent(judged);
    }

    /// Whether a view was built after the reading ck-mc holds: a reading
    /// that names a view older than the newest one the runner applies or
    /// accepted, or one without a view whose size the newest view was
    /// built on or ignored (see the `spent_reading` module).
    fn held_reading_spent(&self, judged: Option<&AppliedView>) -> bool {
        let (Some(tokens), view) = reading_of(&self.conditions) else {
            return false;
        };
        match view.filter(|_| !self.prompt_views_untrusted) {
            Some(view) => view < self.newest_applied.max(self.newest_accepted(judged)),
            None => self.spent_reading.is_some_and(|spent| {
                (spent.tokens == tokens || spent.older == Some(tokens))
                    && self.spent_view_holds(spent.view, judged)
            }),
        }
    }

    /// Settle the views against what a notice or ride says the runner
    /// applies, and against the views it refused at a step boundary. A
    /// statement older than one already taken settles only the refusals.
    pub(super) fn settle_stated(
        &mut self,
        applied: StatedView<'_>,
        refused: &[(u64, ViewRefusal)],
    ) {
        match applied {
            StatedView::Now(applied) => self.settle_unconfirmed(applied, refused),
            StatedView::Older => self.settle_refused(refused),
        }
    }

    /// The view a statement's reading is judged against, and the one ck-mc
    /// compares with its own to see whether the runner applies a view it
    /// doesn't expect. For a statement older than one already taken, that
    /// is the view ck-mc expects the runner to apply, its newest one, so
    /// nothing about the runner's view is judged to have changed.
    pub(super) fn judged_view(&self, applied: StatedView<'_>) -> Option<AppliedView> {
        match applied {
            StatedView::Now(applied) => applied.cloned(),
            StatedView::Older => self.latest.as_ref().map(View::applied),
        }
    }
}
