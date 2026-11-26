//! Pressure: whether a pass may rebuild, and the readings and conditions that
//! decide it.

use super::*;

impl Session {
    fn confirmed_thinking_edits(&self) -> Option<lanes::Edited> {
        use cortexkit_role_compaction::rules::SignedParts;
        if self.conditions.rules.signed_parts != SignedParts::Bound {
            return None;
        }
        // Accepted views can wait for the next step. Until the runner says
        // it applied one, its drops cannot release the thinking hold.
        let view = self.applied_copy()?;
        let rendered = self.rendered_view(Some(view))?;
        Some(lanes::Edited::of(Some(&rendered), &self.index, None))
    }

    pub(super) fn applied_copy(&self) -> Option<&View> {
        self.latest
            .iter()
            .chain(
                self.unconfirmed
                    .iter()
                    .filter_map(|p| p.before.latest.as_ref()),
            )
            .find(|view| view.version == self.newest_applied)
    }

    pub(super) fn signed_thinking_held(&self, pressure: &Conditions, settings: &Settings) -> bool {
        pass::signed_thinking_hold_in_view(
            self.index.entries(),
            pressure,
            settings,
            self.signed_floor(),
            || self.confirmed_thinking_edits(),
        )
    }

    /// Whether the session's own state lets this pass rebuild: a stale head,
    /// or an execute pass with no summary on its way (or in the force band)
    /// and no signed-thinking hold. A notice asks this after admitting a
    /// summary run; a ride whose causes only say the provider forgot its
    /// cache asks it too, but never starts a summary.
    pub(super) fn rebuild_permitted(&mut self, settings: &Settings) -> bool {
        let (hold, execute, force) = {
            let pressure = self.pressure();
            (
                self.signed_thinking_held(&pressure, settings),
                pass::at_execute(&pressure, settings),
                pass::in_force_band(&pressure, settings),
            )
        };
        // A stale reading can't say whether usage is under the hold's cap.
        // When the turn holds heavy signed thinking, a fold waits for a
        // current reading, as the hold would make it wait.
        let fold_held = hold
            || (self.reading_stale
                && pass::heavy_signed_turn_in_view(
                    self.index.entries(),
                    &self.conditions,
                    self.signed_floor(),
                    self.confirmed_thinking_edits().as_ref(),
                ));
        // A fold for a settings or window change waits out a heavy-thinking
        // turn, as an execute pass does: re-rendering `m[0]` then would drop
        // the signed thinking the model just paid for. The change is found
        // again on the next pass. A head made stale by an undo or a restore
        // can't wait: it shows history that no longer holds.
        if !fold_held && self.head_shape_changed(settings) {
            self.fold_due = true;
            self.head_stale = true;
        }
        // Summaries that reached the history without part numbers lift the
        // views held back below it: the runner no longer serves the older
        // view, which cut before that history.
        self.head_stale
            || self.numbers_view_due()
            || (execute && (force || !self.summary_on_its_way()) && !hold)
    }

    /// Judge the reading the conditions just taken carry, once the notice's
    /// or ride's `applied_view` is settled. A reading whose `last_prompt_view`
    /// is older than the view the runner applies, or is 0 (no view) once one
    /// is applied, measured bytes the runner no longer sends: a runner takes
    /// a view while a request is in flight, and that request's size arrives
    /// after the new view went out. Acting on it would build a second view
    /// for pressure the first one already relieved, and rewrite the cache
    /// again for nothing. A reading with no view version is judged only
    /// against the prompt sizes the newest view was built on or ignored
    /// ([`Session::judge_spent_reading`]): the runner could not tie it to a
    /// request, and a repeat of such a size is a measurement from before the
    /// view. So is every reading while the runner's view versions are
    /// disregarded (`prompt_views_untrusted`, below).
    ///
    /// A reading older than a view the runner accepted from ck-mc but does
    /// not apply yet is stale for the same reason ([`Session::newest_accepted`]):
    /// the runner keeps an accepted view pending until its next step and
    /// reports the view before it as applied until then, and renders every
    /// request from then on with the accepted view but at most one. Two
    /// requests can be measured under the older view after acceptance: the
    /// one already in flight when the runner accepted (a session has one
    /// step in flight at a time), and, when the runner accepted between a
    /// tool's answer and the request that follows it, that request, which a
    /// runner may render before it takes the view. A runner takes an
    /// accepted view one request late at most, never two, so the accepted
    /// views excuse two such measurements, and their repeats. A third,
    /// different one shows the runner rendered a later request without the
    /// view it accepted. ck-mc then stops counting the accepted views, warns
    /// once, and judges this reading and later ones by the applied view
    /// alone; the views stay unconfirmed until the runner applies or refuses
    /// them, or Setup offers them again.
    ///
    /// Repeats of the reading last ignored stay ignored. A different reading
    /// older than the same applied view means the runner named a replaced
    /// view for a request it sent later; from then until the next Setup its
    /// view versions are disregarded (`prompt_views_untrusted`): its readings
    /// are judged as if they named no view, and that reading counts. A
    /// reading stale only against an accepted view is never part of that
    /// check: the view a reading names is right there, and only the runner's
    /// applying of accepted views can be at fault.
    ///
    /// The stored conditions keep the last reading that was current, not the
    /// stale one, so the apps keep showing the usage they showed rather than
    /// the larger size from before the newest view, and a restart restores a
    /// reading that was current when it came. Pressure decisions read neither
    /// until a reading under the current view arrives ([`Session::pressure`]).
    pub(super) fn judge_reading(
        &mut self,
        previous: (Option<u64>, Option<u64>),
        applied_view: Option<&AppliedView>,
    ) {
        self.reading_stale = false;
        if let Some(tokens) = self.unversioned_reading() {
            self.judge_spent_reading(previous, tokens, applied_view);
            return;
        }
        let (Some(tokens), Some(view)) = reading_of(&self.conditions) else {
            return;
        };
        let applied = self.newest_applied;
        let accepted = self.newest_accepted(applied_view);
        if view >= applied.max(accepted) {
            return;
        }
        if view >= applied && !self.excuse_in_flight(tokens, view, accepted) {
            // Judged by the applied view alone, which the reading is not
            // older than.
            return;
        }
        if view < applied {
            if let Some((ignored_tokens, ignored_view, _)) = self
                .ignored_reading
                .filter(|ignored| ignored.2 == applied && (ignored.0, ignored.1) != (tokens, view))
            {
                self.prompt_views_untrusted = true;
                self.ignored_reading = None;
                tracing::warn!(
                    session = %self.key.session,
                    applied_view = %applied,
                    prompt_tokens = %tokens,
                    view_version = %view,
                    %ignored_tokens,
                    %ignored_view,
                    "ck-mc: session: a second stale reading named a replaced view; readings count whatever view they name until the next Setup"
                );
                return;
            }
            self.ignored_reading = Some((tokens, view, applied));
        }
        self.reading_stale = true;
        self.note_older_reading(tokens, view);
        let accepted_note = if accepted > applied {
            format!(", accepted {accepted}")
        } else {
            String::new()
        };
        tracing::info!(
            session = %self.key.session,
            prompt_tokens = %tokens,
            view_version = %view,
            applied_view = %applied,
            %accepted_note,
            "ck-mc: session: ignoring a prompt reading from a stale view; waiting for a reading under the current view"
        );
        (
            self.conditions.last_prompt_tokens,
            self.conditions.last_prompt_view,
        ) = previous;
    }

    /// Excuse a reading under an older view than the newest accepted one
    /// (`accepted`) as one of the requests the runner can still measure
    /// under the older view after accepting ([`Unconfirmed::excused`]): the
    /// accepted views record it, and a repeat of it is excused again. A
    /// different reading once an accepted view has excused two stops every
    /// accepted view counting, and returns false.
    fn excuse_in_flight(&mut self, tokens: u64, view: u64, accepted: u64) -> bool {
        let reading = (tokens, view);
        let earlier = self
            .unconfirmed
            .iter()
            .filter(|pending| pending.accepted)
            .find_map(|pending| match pending.excused[..] {
                [first, second] if !pending.excused.contains(&reading) => Some((first, second)),
                _ => None,
            });
        let Some(((first_tokens, first_view), (second_tokens, second_view))) = earlier else {
            // No accepted view holds two other readings, so each has room
            // for this one unless it already holds it.
            for pending in self
                .unconfirmed
                .iter_mut()
                .filter(|pending| pending.accepted)
            {
                if !pending.excused.contains(&reading) {
                    pending.excused.push(reading);
                }
            }
            return true;
        };
        for pending in &mut self.unconfirmed {
            pending.accepted = false;
        }
        tracing::warn!(
            session = %self.key.session,
            accepted_view = %accepted,
            prompt_tokens = %tokens,
            view_version = %view,
            %first_tokens,
            %first_view,
            %second_tokens,
            %second_view,
            applied_view = %self.newest_applied,
            "ck-mc: session: runner accepted a view but measured a later request without it; counting readings against the applied view"
        );
        false
    }

    /// The newest view the runner accepted from ck-mc and still holds
    /// without applying it yet: 0 when there is none. A view leaves the
    /// unconfirmed list the moment the runner refuses it or ck-mc rolls it
    /// back, so it stops counting at once; it also stops counting once a
    /// reading shows the runner rendered a request without it
    /// ([`Session::excuse_in_flight`]). None counts while the runner
    /// applies a view ck-mc doesn't expect (`applied_view`, the one the
    /// notice or ride reports): a runner whose state went back no longer
    /// holds what it accepted, and measures under the view it applies.
    pub(super) fn newest_accepted(&self, applied_view: Option<&AppliedView>) -> u64 {
        if self.runner_differs(applied_view) {
            return 0;
        }
        self.unconfirmed
            .iter()
            .filter(|pending| pending.accepted)
            .map(|pending| pending.view.version)
            .max()
            .unwrap_or(0)
    }

    /// The conditions every pressure decision reads: the execute threshold,
    /// the force band, the summary trigger's pressure, the signed-thinking
    /// hold's cap and the emergency drop's prompt size. After a stale reading
    /// they carry no reading at all, exactly as conditions without
    /// `last_prompt_tokens` do.
    pub(super) fn pressure(&self) -> std::borrow::Cow<'_, Conditions> {
        if !self.reading_stale {
            return std::borrow::Cow::Borrowed(&self.conditions);
        }
        let mut conditions = self.conditions.clone();
        conditions.last_prompt_tokens = None;
        conditions.last_prompt_view = None;
        std::borrow::Cow::Owned(conditions)
    }
}
