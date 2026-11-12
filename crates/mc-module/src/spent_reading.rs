//! Readings from before the newest view.
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
//! the prompt sizes it knows were measured before that view: the spent
//! reading. The first is the size the pass that built the view read. The
//! second is the newest reading the view rule ignored as measured under an
//! older view, the request that was in flight when the runner took the view:
//! a runner that restarts no longer knows which view that reading measured,
//! and its notices carry it again with no view. A later reading without a
//! view version, of exactly one of those sizes, while that view is still the
//! newest one the runner accepted or applies, is stale in the same way as a
//! reading under an older view: no pressure decision acts on it, the stored
//! conditions keep the last current reading, and the emergency latch, the
//! `ctx_keep` request and the mark that lets the next pass summarize past
//! the newest prompt (`floor_pending_for`) stay as they were
//! ([`Session::pressure`]). A different number is a new measurement and
//! counts. A reading that names a view is judged here only while ck-mc
//! disregards the runner's view versions (`prompt_views_untrusted`).
//!
//! Whether that view still holds needs ck-mc's own newest view. After a
//! restart ck-mc reads it back from the runner (`adopt_runner_view`), and a
//! notice that arrives first is judged once more after that read, before its
//! pass decides; no view is built before the read anyway.
//!
//! A view built while the reading is already stale (a ride that says the
//! request will not fit, or that its prefix changes anyway, a `ctx_keep`, a
//! history that must be shown again) was built after the same measurements,
//! so it carries the spent reading forward. A view the runner refuses, or
//! that ck-mc rolls back, puts back the spent reading of the view before it.
//! The runner's own answer forgets it: a read-back that returns a view ck-mc
//! doesn't expect, or a Setup after which the runner holds the view no
//! longer. A read-back that fails says nothing about the runner's view and
//! forgets nothing. The spent reading is kept with the session's saved
//! state, so a restarted ck-mc doesn't rebuild every session that got a view
//! since its runner's last measured request.
//!
//! Nothing waits for ever on a spent reading. Only those two exact sizes are
//! ignored, and only while the view they were spent on holds; any other
//! number is a new measurement and counts. A runner that measures no further
//! request has nothing in flight that a view could still shrink, and the view
//! already built is the one its next request carries. A request that would
//! not fit still reaches ck-mc as an over-limit ride, which builds a view
//! whatever the reading.

use super::*;

/// The prompt sizes known to be measured before a view (see the module
/// docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SpentReading {
    /// The `last_prompt_tokens` the pass that built the view read.
    pub tokens: u64,
    /// The newest view built since the reading arrived.
    pub view: u64,
    /// The newest reading ck-mc ignored as measured under a view older than
    /// `view`. Left out of the saved text while there is none, so rows saved
    /// before it existed don't change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub older: Option<u64>,
    /// A repeat of the newest of those readings was already ignored and
    /// logged for this view.
    #[serde(default)]
    pub ignored: bool,
}

impl Session {
    /// The prompt size of a reading judged by the spent reading alone: one
    /// that names no view, or names one while ck-mc disregards the runner's
    /// view versions.
    pub(super) fn unversioned_reading(&self) -> Option<u64> {
        let (tokens, view) = reading_of(&self.conditions);
        tokens.filter(|_| view.is_none() || self.prompt_views_untrusted)
    }

    /// Judge a reading of `tokens` that [`Session::unversioned_reading`]
    /// gave, once the notice's or ride's `applied_view` is settled: stale
    /// when it repeats a size from before the newest view. Like a reading
    /// under an older view, a stale one leaves the stored conditions at
    /// `previous`, the last current reading.
    pub(super) fn judge_spent_reading(
        &mut self,
        previous: (Option<u64>, Option<u64>),
        tokens: u64,
        applied_view: Option<&AppliedView>,
    ) {
        let Some(spent) = self.spent_reading else {
            return;
        };
        let built_on = spent.tokens == tokens;
        if !(built_on || spent.older == Some(tokens))
            || !self.spent_view_holds(spent.view, applied_view)
        {
            return;
        }
        self.reading_stale = true;
        if !spent.ignored {
            self.spent_reading = Some(SpentReading {
                ignored: true,
                ..spent
            });
            let view = spent.view;
            if built_on {
                tracing::info!(
                    "ck-mc: session {}: ignoring a prompt of {tokens} tokens: view {view} was built on this same reading, so no request under it has been measured yet; waiting for a new reading",
                    self.key.session
                );
            } else {
                tracing::info!(
                    "ck-mc: session {}: ignoring a prompt of {tokens} tokens: it repeats, without its view, a reading ignored as measured before view {view}; waiting for a new reading",
                    self.key.session
                );
            }
        }
        (
            self.conditions.last_prompt_tokens,
            self.conditions.last_prompt_view,
        ) = previous;
    }

    /// Judge the notice's reading against the spent reading again once
    /// `adopt_runner_view` has read ck-mc's own newest view back: before
    /// that, after a restart, ck-mc could not tell whether the spent
    /// reading's view still holds. Returns whether the reading is stale now
    /// and was not before.
    pub(super) fn judge_spent_reading_after_adoption(
        &mut self,
        previous: (Option<u64>, Option<u64>),
        applied_view: Option<&AppliedView>,
    ) -> bool {
        if self.reading_stale {
            return false;
        }
        let Some(tokens) = self.unversioned_reading() else {
            return false;
        };
        self.judge_spent_reading(previous, tokens, applied_view);
        self.reading_stale
    }

    /// The view rule ignored a reading of `tokens` measured under view
    /// `view`. When that view is older than the spent reading's, the reading
    /// was measured before it too, and a later repeat without a view is
    /// stale.
    pub(super) fn note_older_reading(&mut self, tokens: u64, view: u64) {
        let Some(spent) = self.spent_reading.as_mut() else {
            return;
        };
        if view < spent.view && tokens != spent.tokens && spent.older != Some(tokens) {
            spent.older = Some(tokens);
            spent.ignored = false;
        }
    }

    /// Whether view `view` is still the newest one the runner accepted from
    /// ck-mc or reports applying (`applied_view`), with nothing ck-mc
    /// doesn't expect in between.
    pub(super) fn spent_view_holds(&self, view: u64, applied_view: Option<&AppliedView>) -> bool {
        !self.runner_differs(applied_view)
            && view == self.newest_applied.max(self.newest_accepted(applied_view))
    }

    /// Record the reading the pass that built view `version` read, as the
    /// runner takes the view. A pass whose reading is stale or missing read
    /// none, and the view carries forward the sizes the view before it was
    /// spent on.
    pub(super) fn spend_reading(&mut self, version: u64) {
        let read = self.pressure().last_prompt_tokens;
        self.spent_reading = match read {
            Some(tokens) => Some(SpentReading {
                tokens,
                view: version,
                older: None,
                ignored: false,
            }),
            None => self.spent_reading.map(|spent| SpentReading {
                view: version,
                ignored: false,
                ..spent
            }),
        };
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
    /// runner no longer holds the view it was spent on, so those readings
    /// count again. Only an answer says so: while ck-mc's own view is
    /// unknown because reading it back failed, the spent reading stays.
    pub(super) fn settle_spent_reading(&mut self, applied_view: Option<&AppliedView>) {
        if self.latest_unknown {
            return;
        }
        if self
            .spent_reading
            .is_some_and(|spent| !self.spent_view_holds(spent.view, applied_view))
        {
            self.spent_reading = None;
        }
    }
}
