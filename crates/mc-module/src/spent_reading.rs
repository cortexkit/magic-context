//! The reading a view was built on.
//!
//! A runner reports the prompt size of its last measured request
//! (`last_prompt_tokens`) in the conditions of every notice and ride until it
//! measures the next one. When a pass builds a view from such a reading, the
//! notices that follow repeat the same number for as long as the runner has
//! measured no request under the new view: the runner writes the reply and
//! the tool results of the measured request, and each write is a notice. The
//! number is the measurement the view was already built from. It says nothing
//! about the requests the view makes, and acting on it builds a second view
//! for pressure the first one already relieved: the runner then sends one
//! request under each view, and the provider writes the cache twice.
//!
//! A runner that names the view each reading measured (`last_prompt_view`)
//! lets [`Session::judge_reading`] see that from the version. One that names
//! none gives only the number, so ck-mc keeps, with the newest view it built,
//! the prompt size the pass that built it read: the spent reading. A later
//! reading without a view version, of exactly that size, while that view is
//! still the newest one the runner accepted or applies, is stale in the same
//! way as a reading under an older view: no pressure decision acts on it, the
//! stored conditions keep the last current reading, and the emergency latch,
//! the `ctx_keep` request and the summary floor mark stay as they were
//! ([`Session::pressure`]). A different number is a new measurement and
//! counts. A reading that names a view is never judged here.
//!
//! A view built while the reading is already stale (a ride that says the
//! request will not fit, or that its prefix changes anyway, a `ctx_keep`, a
//! history that must be shown again) was built after the same measurement,
//! so it carries the spent reading forward. A view the runner refuses, or
//! that ck-mc rolls back, puts back the spent reading of the view before it;
//! one the runner replaced with a view ck-mc doesn't expect forgets it, and
//! so does a Setup after which the runner holds the view no longer. The
//! spent reading is kept with the session's saved state, so a restarted
//! ck-mc doesn't rebuild every session that got a view since its runner's
//! last measured request.
//!
//! Nothing waits for ever on a spent reading. Requests under one view only
//! grow, since the runner appends to the transcript, so at most one of them
//! can measure exactly the spent size, and every later one counts. A runner
//! that measures no further request has nothing in flight that a view could
//! still shrink, and the view already built is the one its next request
//! carries. A request that would not fit still reaches ck-mc as an over-limit
//! ride, which builds a view whatever the reading.

use super::*;

/// The prompt size a view was built on (see the module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SpentReading {
    /// The reading's `last_prompt_tokens`.
    pub tokens: u64,
    /// The newest view built since the reading arrived.
    pub view: u64,
    /// A repeat of the reading was already ignored and logged for this view.
    #[serde(default)]
    pub ignored: bool,
}

impl Session {
    /// Judge a reading that names no view (`tokens`, from the conditions just
    /// taken), once the notice's or ride's `applied_view` is settled: stale
    /// when it repeats the reading the newest view was built on. Like a
    /// reading under an older view, a stale one leaves the stored conditions
    /// at `previous`, the last current reading.
    pub(super) fn judge_spent_reading(
        &mut self,
        previous: (Option<u64>, Option<u64>),
        tokens: u64,
        applied_view: Option<&AppliedView>,
    ) {
        let Some(spent) = self.spent_reading else {
            return;
        };
        if spent.tokens != tokens || !self.spent_view_holds(spent.view, applied_view) {
            return;
        }
        self.reading_stale = true;
        if !spent.ignored {
            self.spent_reading = Some(SpentReading {
                ignored: true,
                ..spent
            });
            let view = spent.view;
            tracing::info!(
                "ck-mc: session {}: ignoring a prompt of {tokens} tokens: view {view} was built on this same reading, so no request under it has been measured yet; waiting for a new reading",
                self.key.session
            );
        }
        (
            self.conditions.last_prompt_tokens,
            self.conditions.last_prompt_view,
        ) = previous;
    }

    /// Whether view `view` is still the newest one the runner accepted from
    /// ck-mc or reports applying (`applied_view`), with nothing ck-mc
    /// doesn't expect in between.
    fn spent_view_holds(&self, view: u64, applied_view: Option<&AppliedView>) -> bool {
        !self.runner_differs(applied_view)
            && view == self.newest_applied.max(self.newest_accepted(applied_view))
    }

    /// Record the reading the pass that built view `version` read, as the
    /// runner takes the view. A pass whose reading is stale or missing read
    /// none, and the view carries forward the reading the view before it
    /// was built on.
    pub(super) fn spend_reading(&mut self, version: u64) {
        let tokens = self
            .pressure()
            .last_prompt_tokens
            .or(self.spent_reading.map(|spent| spent.tokens));
        self.spent_reading = tokens.map(|tokens| SpentReading {
            tokens,
            view: version,
            ignored: false,
        });
    }

    /// The runner's own view replaces ck-mc's (`session.applied_view`, see
    /// [`Session::adopt_runner_view`]). The spent reading stays only when
    /// that view is the one it was spent on, as after a restart that read
    /// back the view ck-mc built.
    pub(super) fn keep_spent_reading_for(
        &mut self,
        answer: &cortexkit_role_compaction::view::AppliedViewAnswer,
    ) {
        let ours = answer
            .view
            .as_ref()
            .filter(|_| {
                answer
                    .applied_by
                    .as_deref()
                    .is_none_or(|id| id == crate::MODULE_ID)
            })
            .map(|view| view.version);
        if self
            .spent_reading
            .is_some_and(|spent| ours != Some(spent.view))
        {
            self.spent_reading = None;
        }
    }

    /// After Setup settled the views: forget the spent reading when the
    /// runner no longer holds the view it was spent on, so that reading
    /// counts again.
    pub(super) fn settle_spent_reading(&mut self, applied_view: Option<&AppliedView>) {
        if self
            .spent_reading
            .is_some_and(|spent| !self.spent_view_holds(spent.view, applied_view))
        {
            self.spent_reading = None;
        }
    }
}
