//! Handing views to the runner and settling its answers: acceptance,
//! refusals and roll-backs.

use super::*;

impl Session {
    /// Hand `view` to the runner. It is accepted first, as unconfirmed, and
    /// the session's state saved, so that whatever happens to the call, a
    /// restarted ck-mc knows the view may be in the runner's hands. A view
    /// the runner refuses, or a call that fails, puts the state back. A call
    /// that got no answer leaves the view as handed over, since the runner
    /// may hold it ([`Unconfirmed::answer_lost`]).
    ///
    /// Returns whether the view may be in the runner's hands: true when the
    /// runner accepted it or the call got no answer, and, after an answer
    /// ck-mc doesn't know, when the runner reports applying it.
    pub(super) async fn publish<C: RunnerClient>(&mut self, client: &C, view: View) -> bool {
        self.publish_recorded(client, view).await.0
    }

    pub(super) async fn publish_recorded<C: RunnerClient>(
        &mut self,
        client: &C,
        view: View,
    ) -> (bool, Option<crate::store::Durable>) {
        if self.suspended || self.transcript_behind.is_some() || self.refuse_oversized(&view) {
            return (false, None);
        }
        self.accept(view.clone());
        let durable = self.durable();
        if let Err(error) = self.save_state(&durable) {
            tracing::warn!(%error, "ck-mc: session: failed to save view state");
            self.roll_back(view.version, false, None);
            return (false, None);
        }
        let request = ApplyViewRequest::new(view.clone());
        let handed_over_ms = user_commands::wall_now();
        match client.apply_view(&self.key, request).await {
            // Accepted, or refused as not newer than this very view: the
            // runner holds it either way. The second answer comes when the
            // client sent the request again after a first attempt that may
            // have reached the runner, and the runner took that one.
            Ok(answer) if holds_offered(&answer, view.version) => {
                self.runner_holds(view.version);
                self.log_view_accepted(&view, None);
                self.app_view_status(view.version, "accepted");
                return (true, Some(durable));
            }
            Ok(ApplyViewAnswer::Refused { refusal }) => {
                if !self.take_move_refusal(client, view.version, &refusal).await {
                    tracing::warn!(
                        session = %self.key.session,
                        view_version = %view.version,
                        ?refusal,
                        "ck-mc: session: runner refused a view"
                    );
                }
                self.roll_back_refused(&view, view.version, &refusal);
            }
            // An answer the contract may add later leaves the outcome
            // unknown (compaction contract W1.5): the view is not sent again,
            // and ck-mc takes whatever view the runner applies.
            Ok(other) => {
                tracing::info!(
                    session = %self.key.session,
                    view_version = %view.version,
                    answer = ?other,
                    "ck-mc: session: unknown answer to a view"
                );
                self.roll_back(view.version, false, None);
                self.adopt_runner_view(client).await;
                let delivered = self.newest_applied == view.version
                    && self
                        .latest
                        .as_ref()
                        .is_some_and(|held| held.checksum == view.checksum);
                return (delivered, Some(durable));
            }
            // The request may have reached the runner, but no answer came
            // back, so the runner may hold the view. Rolling it back would
            // queue its drops again and show it undelivered while the runner
            // serves it. It stays as handed over, the state a ck-mc restart
            // right after the call finds: the runner's next report confirms
            // it, or the next notice offers it again, and a refusal then
            // rolls it back.
            Err(error) if error.outcome_unknown => {
                tracing::warn!(
                    session = %self.key.session,
                    view_version = %view.version,
                    %error,
                    "ck-mc: session: no answer to a view, which the runner may hold; waiting for the runner's next report"
                );
                if let Some(pending) = self
                    .unconfirmed
                    .iter_mut()
                    .find(|pending| pending.view.version == view.version)
                {
                    pending.answer_lost = true;
                    pending.handed_over_ms = Some(handed_over_ms);
                }
                self.reoffer_pending = true;
                return (true, Some(durable));
            }
            Err(error) => {
                self.runner_call_failed("session.apply_view", &error);
                self.roll_back(view.version, false, None);
            }
        }
        (false, Some(durable))
    }

    /// A view handed over before ck-mc restarted, or one whose
    /// `session.apply_view` got no answer, that the runner does not report
    /// applying: it may never have arrived, so it is offered again.
    /// A runner that already holds it refuses it as not newer, which
    /// confirms nothing but loses nothing; any other refusal rolls it back.
    /// Which unconfirmed views the runner holds is judged afresh only after
    /// a Setup or a resume ([`Session::judge_acceptance_afresh`]), not when
    /// an ordinary notice offers a waiting view again.
    pub(super) async fn offer_unconfirmed_again<C: RunnerClient>(
        &mut self,
        client: &C,
        applied: StatedView<'_>,
    ) {
        if self.adoption_retry.is_some() {
            return;
        }
        self.reoffer_pending = false;
        let Some(view) = self.unconfirmed.last().map(|pending| pending.view.clone()) else {
            return;
        };
        let oldest = self.unconfirmed[0].view.version;
        // An older ck-mc saved views without their policy members
        // (`built_through`, `new_signed`), which their checksum covers. Such
        // a view can't be repaired, since nothing else records the message
        // it was built through, and the runner would refuse it for its
        // checksum. It goes back as undelivered: its parts did nothing
        // wrong, so the rebuild may carry them again.
        if !view.verify() {
            let why = if view.built_through.is_none() && view.new_signed.is_none() {
                "saved without its policy members"
            } else {
                "no longer matches its checksum as saved"
            };
            tracing::warn!(
                session = %self.key.session,
                view_version = %view.version,
                reason = %why,
                "ck-mc: session: rebuilding a view instead of offering it again"
            );
            self.roll_back(oldest, false, None);
            return;
        }
        if let StatedView::Now(applied) = applied {
            self.unconfirmed.last_mut().unwrap().reoffered_from = Some(applied.cloned());
        }
        // Saved by a build from before the move floor was known, a view may
        // cut before it. Such a view is not offered again: ck-mc puts back
        // what accepting it changed, as when its fate is unknown, and takes
        // whatever view the runner reports applying. A runner that can't
        // place the view's cut yet decides nothing: the view is offered
        // again on the next notice.
        match self.move_floor_breach_placed(client, &view).await {
            Ok(Some(why)) => {
                self.hold_below_move_floor(&why);
                self.roll_back(oldest, false, None);
                return;
            }
            Ok(None) => {}
            Err(move_floor::PlaceLater) => {
                tracing::info!(
                    session = %self.key.session,
                    view_version = %view.version,
                    "ck-mc: session: a view is offered again on the next notice because the runner can't place its cut yet"
                );
                self.reoffer_pending = true;
                return;
            }
        }
        // Nor is a view that cuts before history the runner now serves
        // without part numbers, when the index already shows that history.
        if let Some(why) = self.numbers_floor_breach(&view) {
            self.hold_below_numbers_floor(&why);
            self.roll_back(oldest, false, None);
            return;
        }
        match client
            .apply_view(&self.key, ApplyViewRequest::new(view.clone()))
            .await
        {
            Ok(ApplyViewAnswer::Accepted) => {
                self.runner_holds(view.version);
                self.app_view_status(view.version, "accepted");
                // The runner took the view with this offer, so a view whose
                // first answer was lost is accepted from now.
                self.lost_answer_found(view.version, false);
            }
            // Refused as not newer than the view the runner holds: it holds
            // this one, from an earlier handover.
            Ok(ApplyViewAnswer::Refused {
                refusal: ViewRefusal::StaleVersion { latest, .. },
            }) if latest == view.version => {
                self.runner_holds(view.version);
                self.reset_transcript_retry();
                self.lost_answer_found(view.version, true);
            }
            Ok(ApplyViewAnswer::Refused { refusal }) => {
                if !self.take_move_refusal(client, view.version, &refusal).await {
                    tracing::warn!(
                        session = %self.key.session,
                        view_version = %view.version,
                        ?refusal,
                        policy_members = %policy_members(&view),
                        "ck-mc: session: runner refused a view offered again"
                    );
                }
                self.roll_back_refused(&view, oldest, &refusal);
            }
            Ok(other) => {
                tracing::info!(
                    session = %self.key.session,
                    view_version = %view.version,
                    answer = ?other,
                    "ck-mc: session: unknown answer to a view offered again"
                );
                self.roll_back(oldest, false, None);
            }
            // As when the view was first handed over: an offer whose answer
            // was lost may have reached the runner, so the view stays as it
            // is and the next notice offers it again. A view whose first
            // answer was lost too keeps that first handover's time.
            Err(error) if error.outcome_unknown => {
                tracing::warn!(
                    session = %self.key.session,
                    view_version = %view.version,
                    %error,
                    "ck-mc: session: no answer to a view offered again, which the runner may hold; waiting for the runner's next report"
                );
                self.reoffer_pending = true;
            }
            Err(error) => {
                self.runner_call_failed(&format!("offering view {} again", view.version), &error);
                self.roll_back(oldest, false, None);
            }
        }
    }

    /// A runner that set up again, or a session that resumes after being
    /// held, may have lost a view the runner had accepted. The answer to the
    /// offer that follows says again whether the runner holds the view, and
    /// its readings are judged afresh from here. Not done when an ordinary
    /// notice offers a waiting view again: the runner's earlier acceptances
    /// still stand then.
    pub(super) fn judge_acceptance_afresh(&mut self) {
        for pending in &mut self.unconfirmed {
            pending.accepted = false;
            pending.excused.clear();
            pending.reoffered_from = None;
        }
    }

    /// Undo `view` after the runner refused it, together with every
    /// unconfirmed view from `from` on: on first handover `from` is the
    /// view itself, and on an offer again it is the oldest view waiting.
    /// Both answers are judged the same way here, so a refusal blames the
    /// same drops whichever offer drew it.
    fn roll_back_refused(&mut self, view: &View, from: u64, refusal: &ViewRefusal) {
        // The runner holds a newer view than ck-mc knows (one handed over
        // before a crash): the next view must be newer still, and the drops
        // this one carried were not at fault.
        let stale = match refusal {
            ViewRefusal::StaleVersion { latest, .. } => {
                self.version = self.version.max(*latest);
                true
            }
            _ => false,
        };
        // A signed part ck-mc kept only because of a signed floor the runner
        // did not apply: the floor, not the drops the view carried, was at
        // fault. They stay queued, with no refusal counted against them; the
        // apps still show the view as refused. Right after a restart the
        // index is still empty, so nothing is placed and the usual penalty
        // applies.
        let floor_at_fault = self.judge_floor_refusal(&view.edits, view.version, refusal);
        // A cut before history without part numbers: the cut was at fault,
        // not the drops, and the next views wait for a summary through that
        // history instead of repeating it.
        let numbers = self.take_numbers_refusal(view.version, refusal);
        let move_cut = matches!(refusal, ViewRefusal::CutBeforeMove { .. });
        // A refusal that names the part at fault blames only that part.
        self.roll_back(
            from,
            !stale && !floor_at_fault && !numbers && !move_cut,
            refusal_part(refusal),
        );
        if floor_at_fault || move_cut {
            self.app_view_status(from, "refused");
        }
        self.reset_transcript_retry();
        self.lost_view_offer_ended(from);
    }

    /// The runner answered an offer again of view `version`. If the first
    /// answer to that view was lost, ck-mc now knows the runner holds it, so
    /// its acceptance is logged here, dated by the handover the runner took,
    /// and not again on confirmation. `held_before` says the runner already
    /// held the view from an earlier handover (it refused this offer as not
    /// newer): the line then carries the first handover's time. Otherwise the
    /// runner took the view with this offer, and the usual line, written now,
    /// dates it.
    fn lost_answer_found(&mut self, version: u64, held_before: bool) {
        let Some(pending) = self
            .unconfirmed
            .iter()
            .find(|pending| pending.view.version == version && pending.answer_lost)
        else {
            return;
        };
        if held_before {
            self.log_held_after_lost_answer(pending);
        } else {
            self.log_view_accepted(&pending.view, None);
        }
        if let Some(pending) = self
            .unconfirmed
            .iter_mut()
            .find(|pending| pending.view.version == version)
        {
            pending.answer_lost = false;
            pending.handed_over_ms = None;
        }
    }

    /// The acceptance line of a view whose apply answer was lost, logged when
    /// the runner shows it holds the view from an earlier handover: the usual
    /// line, then a note ending with when ck-mc first handed the view over.
    /// The line comes later than that handover, often after the step that
    /// first rendered the view, so the cache-bust watcher takes the stated
    /// time as the view's.
    fn log_held_after_lost_answer(&self, pending: &Unconfirmed) {
        let note = match pending.handed_over_ms {
            Some(at) => format!(
                "confirmed by the runner after its apply answer was lost; handed over at {}",
                crate::upkeep::iso_8601(at)
            ),
            None => "confirmed by the runner after its apply answer was lost".to_owned(),
        };
        self.log_view_accepted(&pending.view, Some(&note));
    }

    /// Save the session's state now, where a store is set.
    pub(super) fn save(&mut self) -> Result<(), String> {
        self.save_state(&self.durable())
    }

    fn save_state(&mut self, durable: &crate::store::Durable) -> Result<(), String> {
        if let Some(store) = &self.store {
            store.save(&self.key, durable)?;
        }
        self.app_save_decisions();
        Ok(())
    }

    /// Forget queued drops that landed or can never land.
    pub(super) fn forget_queued(&mut self, parts: &[lanes::PartKey]) {
        for part in parts {
            self.app_projection.dirty.insert(part.0.clone());
            self.queued.remove(part);
            self.refused_once.remove(part);
            self.app_prune_stamps([part.clone()]);
        }
    }

    /// The runner did not take a view: its queued drops stay queued for the
    /// next one, except those blamed by a refused view already once. When a
    /// refusal names a culprit, the other drops did not cause the failure.
    fn keep_refused_drops(&mut self, culprit: Option<&lanes::PartKey>) {
        for part in std::mem::take(&mut self.next_covered) {
            if culprit.is_some_and(|culprit| *culprit != part) {
                continue;
            }
            if !self.queued.contains(&part) {
                continue;
            }
            if self.refused_once.insert(part.clone()) {
                continue;
            }
            tracing::warn!(
                session = %self.key.session,
                mid = %part.0,
                part = %part.1,
                "ck-mc: session: queued drop forgotten after a second refused view"
            );
            self.queued.remove(&part);
            self.app_projection.dirty.insert(part.0.clone());
            self.app_prune_stamps([part.clone()]);
            self.refused_once.remove(&part);
        }
    }

    /// Take `view` as the one the runner shows, unconfirmed until a notice
    /// reports it applied (see [`Unconfirmed`]).
    /// Move the age-sweep bookmark to where the last build left it.
    pub(super) fn commit_bookmark(&mut self) {
        if let Some(bookmark) = self.next_reclaim_bookmark.take() {
            self.reclaim_bookmark = self.reclaim_bookmark.max(bookmark);
        }
        if let Some(bookmark) = self.next_notice_reclaim_bookmark.take() {
            self.notice_reclaim_bookmark = self.notice_reclaim_bookmark.max(bookmark);
        }
    }

    pub(super) fn accept(&mut self, view: View) {
        let flush = std::mem::take(&mut self.next_flush);
        let _timing = crate::notice_cost_timing::span("publish.accept");
        self.app_record_view(&view);
        let covered = std::mem::take(&mut self.next_covered);
        let mut cut_covered = Vec::new();
        // A cut removes everything before it from the request, so it also
        // carries out queued drops of parts behind it without naming them
        // in the view. Record those, so a refused cut can restore them.
        // Record them before applying the cut prunes their index entries.
        if let Some(cut) = move_floor::cut_of(&view).and_then(|mid| self.index.ordinal_of(mid)) {
            for key in &self.queued {
                if self
                    .index
                    .ordinal_of(&key.0)
                    .is_some_and(|ordinal| ordinal <= cut)
                    && !covered.contains(key)
                {
                    cut_covered.push(key.clone());
                }
            }
        }
        let (pending_keep, pending_keep_after) = self.take_landed_keep();
        let before = Before {
            head_stale: self.head_stale,
            latest: self.latest.clone(),
            queued: self.queued.clone(),
            refused_once: self.refused_once.clone(),
            transcript_retry: self.transcript_retry,
            emergency_latched: self.emergency_latched,
            baseline: self.baseline.clone(),
            fold_due: self.fold_due,
            caveman: self.caveman.clone(),
            cut: self.cut,
            pruned_turns: self.pruned_turns,
            reclaim_bookmark: Some(self.reclaim_bookmark),
            notice_reclaim_bookmark: Some(self.notice_reclaim_bookmark),
            summary_unshown: self.summary_unshown,
            pending_keep,
            pending_keep_after,
            spent_reading: self.spent_reading,
            render_recovery: Some(self.render_failed.recovery()),
        };
        self.commit_bookmark();
        self.unconfirmed.push(Unconfirmed {
            view: view.clone(),
            covered: covered.clone(),
            cut_covered: cut_covered.clone(),
            before,
            reoffered_from: None,
            built_through: self.index.cursor().map(|cursor| cursor.ordinal),
            accepted: false,
            excused: Vec::new(),
            answer_lost: false,
            handed_over_ms: None,
        });
        self.forget_queued(&covered);
        self.forget_queued(&cut_covered);
        if std::mem::take(&mut self.next_latch) {
            self.emergency_latched = true;
        } else if std::mem::take(&mut self.next_rearm) {
            self.emergency_latched = false;
        }
        if let Some(next) = self.next_baseline.take() {
            self.head_stale = false;
            self.baseline = Some(next);
            if !flush {
                self.fold_due = false;
            }
            self.summary_unshown = false;
        }
        if let Some(next) = self.next_caveman.take() {
            self.caveman = next;
        }
        self.version = self.version.max(view.version);
        self.spend_reading(view.version);
        self.apply_cut(&view);
        self.render_failed.recorded(&view);
        self.latest = Some(view);
    }

    /// The runner said it holds the unconfirmed view `version` (see
    /// [`Unconfirmed::accepted`]).
    pub(super) fn runner_holds(&mut self, version: u64) {
        self.render_failed.held(version);
        if let Some(pending) = self
            .unconfirmed
            .iter_mut()
            .find(|pending| pending.view.version == version)
        {
            pending.accepted = true;
        }
    }

    /// Settle the unconfirmed views against what the runner reports: each
    /// one it applies (or a later one it applies) is confirmed, and one it
    /// refused is rolled back with every view built on it.
    pub(super) fn settle_unconfirmed(
        &mut self,
        applied: Option<&AppliedView>,
        refused: &[(u64, ViewRefusal)],
    ) {
        // The runner reports the view it applies now, and none when the field
        // is absent. Taken as it stands, not as a maximum: a runner whose
        // state went back, or that stopped applying any view, measures its
        // requests under what it applies now.
        self.newest_applied = applied.map_or(0, |applied| applied.version);
        self.app_confirm_head(self.newest_applied);
        // The view the runner applies is ck-mc's own when ck-mc holds it,
        // confirmed already or waiting for this report.
        let own = applied.and_then(|applied| {
            self.unconfirmed
                .iter()
                .map(|pending| &pending.view)
                .chain(self.latest.as_ref())
                .find(|view| same(applied, view))
                .map(cuts)
        });
        if let Some(cuts) = own {
            self.runner_applies_own_view(cuts);
        }
        if let Some(applied) = applied {
            self.render_failed.held(applied.version);
            // Views are cumulative: applying a view applies every edit of the
            // unconfirmed ones before it.
            if let Some(at) = self
                .unconfirmed
                .iter()
                .position(|pending| same(applied, &pending.view))
            {
                let stamp_keys: Vec<_> = self.unconfirmed[..=at]
                    .iter()
                    .flat_map(|first| first.before.queued.iter().cloned())
                    .collect();
                if let Some(first) = self.unconfirmed.first() {
                    self.app_projection
                        .dirty
                        .extend(first.before.queued.iter().map(|key| key.0.clone()));
                }
                let versions: Vec<_> = self.unconfirmed[..=at]
                    .iter()
                    .map(|pending| pending.view.version)
                    .collect();
                for version in versions {
                    self.app_view_status(version, "applied");
                }
                // A view whose answer was lost, and whose offer again has not
                // been answered either, never logged its acceptance. The
                // runner's report is the first word that it took the view, so
                // the line the cache-bust analyzer looks for is written now,
                // once, as the view leaves the list, dated by when the view
                // was handed over.
                for pending in self.unconfirmed[..=at]
                    .iter()
                    .filter(|pending| pending.answer_lost)
                {
                    self.log_held_after_lost_answer(pending);
                }
                self.unconfirmed.drain(..=at);
                self.reset_transcript_retry();
                self.app_prune_stamps(stamp_keys);
                if let Some(first) = self.unconfirmed.first() {
                    self.app_projection
                        .dirty
                        .extend(first.before.queued.iter().map(|key| key.0.clone()));
                }
            }
        }
        self.settle_refused(refused);
    }

    /// Roll back the oldest unconfirmed view the runner refused at a step
    /// boundary, with every view built on it.
    pub(super) fn settle_refused(&mut self, refused: &[(u64, ViewRefusal)]) {
        // A step-boundary refusal of any view, the one in force included,
        // can name history the runner serves without part numbers; the
        // floor it names holds whichever view it was.
        let mut numbers = BTreeSet::new();
        for (version, refusal) in refused {
            if self.take_numbers_refusal(*version, refusal) {
                numbers.insert(*version);
            }
        }
        if let Some((version, refusal)) = refused
            .iter()
            .filter(|(version, _)| {
                self.unconfirmed
                    .iter()
                    .any(|pending| pending.view.version == *version)
            })
            .min_by_key(|(version, _)| *version)
        {
            let moved =
                TranscriptRefusal::of(refusal).or_else(|| self.new_signed_part(*version, refusal));
            // A signed part the view knew, kept only because of a signed
            // floor the runner did not apply: the floor was at fault, not
            // the drops, and the retry pays no penalty.
            let kept = match moved {
                Some(_) => None,
                None => self
                    .unconfirmed
                    .iter()
                    .find(|pending| pending.view.version == *version)
                    .and_then(|pending| self.kept_for_a_floor(&pending.view.edits, refusal)),
            };
            if kept == Some(true) {
                self.disprove_floor(*version, refusal);
            }
            let floor_at_fault = kept.is_some()
                || numbers.contains(version)
                || matches!(refusal, ViewRefusal::CutBeforeMove { .. });
            // FinalTurnRemoved depends on the newest entry; UnknownMessage
            // can follow a revert. Neither blames a drop when an accepted
            // view first loses that race. Only its immediate retry pays the
            // usual refusal penalty if the same reason repeats. A new signed
            // part never pays it: the part did not exist when ck-mc built
            // the view, so no repeat can be ck-mc's own fault.
            let guard = !floor_at_fault
                && match moved {
                    None => true,
                    Some(TranscriptRefusal::NewSignedPart) => false,
                    Some(kind) => self.transcript_retry == Some((kind, *version)),
                };
            self.roll_back(*version, guard, refusal_part(refusal));
            self.lost_view_offer_ended(*version);
            // Retrying skips drop penalties, not the refusal status shown
            // in the apps' view history.
            self.app_view_status(*version, "refused");
            self.reset_transcript_retry();
            self.transcript_retry = moved
                .filter(|kind| *kind != TranscriptRefusal::NewSignedPart)
                .map(|kind| (kind, self.version + 1));
        }
    }

    /// Whether `refusal` names a signed part in an entry newer than any the
    /// index held when view `version` was built. A part ck-mc cannot place
    /// counts as new: every entry the view knew stays indexed until a
    /// confirmed view changes which entries the index holds.
    fn new_signed_part(&self, version: u64, refusal: &ViewRefusal) -> Option<TranscriptRefusal> {
        let ViewRefusal::Rule(RuleBreak::SignedPartInvalid { mid, .. }) = refusal else {
            return None;
        };
        let through = self
            .unconfirmed
            .iter()
            .find(|pending| pending.view.version == version)?
            .built_through?;
        match self.index.ordinal_of(mid) {
            Some(ordinal) if ordinal <= through => None,
            _ => Some(TranscriptRefusal::NewSignedPart),
        }
    }

    fn reset_transcript_retry(&mut self) {
        self.transcript_retry = None;
        // A later rollback must not resurrect a guard reset by an applied
        // view or a different refusal.
        for pending in &mut self.unconfirmed {
            pending.before.transcript_retry = None;
        }
    }

    /// Put back what accepting the view `version`, and every view built on
    /// it, changed. Its queued drops are queued again, except one that a
    /// refused view already blamed once: a drop the runner keeps refusing
    /// must not make every later pass build a view it refuses.
    pub(super) fn roll_back(
        &mut self,
        version: u64,
        refused: bool,
        culprit: Option<lanes::PartKey>,
    ) {
        if let Some(record) = self
            .app_decisions
            .iter_mut()
            .find(|r| r["view_version"] == version)
        {
            let status = if refused { "refused" } else { "undelivered" };
            if record["status"] != status {
                record["status"] = serde_json::json!(status);
                self.app_decisions_revision += 1;
                self.app_decisions_unsaved
                    .entry(version)
                    .or_insert(crate::store::DecisionWrite::StatusChanged);
            }
        }
        let Some(at) = self
            .unconfirmed
            .iter()
            .position(|pending| pending.view.version == version)
        else {
            return;
        };
        let undone = self.unconfirmed.split_off(at);
        let first = &undone[0];
        let before = first.before.clone();
        if let Some(recovery) = before.render_recovery {
            self.render_failed.restore_recovery(recovery);
        }
        self.app_projection.dirty.extend(
            self.queued
                .iter()
                .chain(&before.queued)
                .map(|key| key.0.clone()),
        );
        let covered: Vec<lanes::PartKey> = undone
            .iter()
            .flat_map(|pending| pending.covered.iter().cloned())
            .collect();
        let cut_moved = self.cut != before.cut;
        self.latest = before.latest;
        // A view saved by an older ck-mc may lack the policy members its
        // checksum covers. It can't stand for the view the runner applies:
        // the next view would differ from it in policy alone and be built
        // for nothing. Read the runner's own copy back before building.
        if self.latest.as_ref().is_some_and(|view| !view.verify()) {
            self.latest_unknown = true;
        }
        self.restore_unconfirmed_stamps(&undone, |_| true);
        self.transcript_retry = before.transcript_retry;
        self.emergency_latched = before.emergency_latched;
        self.summary_unshown |= before.summary_unshown;
        self.restore_unconfirmed_keep(&undone);
        self.spent_reading = before.spent_reading;
        self.baseline = before.baseline;
        self.app_projection.head_read.offered = None;
        self.fold_due = before.fold_due;
        self.head_stale |= undone.iter().any(|pending| pending.before.head_stale);
        self.caveman = before.caveman;
        self.cut = before.cut;
        self.pruned_turns = before.pruned_turns;
        if let Some(bookmark) = before.reclaim_bookmark {
            self.reclaim_bookmark = bookmark;
        }
        if let Some(bookmark) = before.notice_reclaim_bookmark {
            self.notice_reclaim_bookmark = bookmark;
        }
        if cut_moved {
            // The index already forgot what the cut removed; read it again
            // from the cut the runner still shows.
            self.index = Index::starting_at(self.cut.unwrap_or(1));
            self.index_ready = false;
        }
        if refused {
            // A refusal that names the part at fault sets aside only that
            // part; one that names none sets aside every automatic part the
            // view carried, so the same view is not built again.
            let at_fault: Vec<lanes::PartKey> = match &culprit {
                Some(part) => covered.iter().filter(|key| *key == part).cloned().collect(),
                None => covered.clone(),
            };
            self.failed_parts.extend(
                at_fault
                    .into_iter()
                    .filter(|part| !self.queued.contains(part)),
            );
            self.next_covered = covered;
            self.keep_refused_drops(culprit.as_ref());
        }
    }

    /// Put back into the queue the parts the agent asked to remove with
    /// `ctx_reduce` that the discarded views had taken off it, leaving parts
    /// queued since then untouched.
    fn restore_unconfirmed_stamps(
        &mut self,
        discarded: &[Unconfirmed],
        restore: impl Fn(&lanes::PartKey) -> bool,
    ) {
        for pending in discarded {
            for part in pending.covered.iter().chain(&pending.cut_covered) {
                if pending.before.queued.contains(part) && restore(part) {
                    self.queued.insert(part.clone());
                    self.app_projection.dirty.insert(part.0.clone());
                    if pending.before.refused_once.contains(part) {
                        self.refused_once.insert(part.clone());
                    }
                }
            }
        }
    }

    fn restore_unconfirmed_keep(&mut self, discarded: &[Unconfirmed]) {
        if self.pending_keep.is_none() {
            if let Some(before) = discarded
                .iter()
                .rev()
                .map(|p| &p.before)
                .find(|before| before.pending_keep.is_some())
            {
                self.pending_keep.clone_from(&before.pending_keep);
                self.pending_keep_after = before.pending_keep_after;
            }
        }
    }

    /// A ride's view whose answer never reached the runner (its deadline
    /// passed): the runner never had it.
    pub fn ride_undelivered(&mut self, version: u64) {
        self.roll_back(version, false, None);
    }

    /// Whether the runner applies a view ck-mc does not expect: neither its
    /// latest nor, while views wait for confirmation, the one before them
    /// or the one the runner reported just before accepting a retry.
    pub(super) fn runner_differs(&self, applied: Option<&AppliedView>) -> bool {
        // After a restart ck-mc must read the view back before building.
        if self.latest_unknown {
            return true;
        }
        let expected = |view: Option<&View>| match (applied, view) {
            (Some(applied), Some(view)) => same(applied, view),
            (None, None) => true,
            _ => false,
        };
        let waiting = self
            .unconfirmed
            .first()
            .map(|pending| pending.before.latest.as_ref());
        !(expected(self.latest.as_ref())
            || waiting.is_some_and(expected)
            || self.unconfirmed.iter().any(|pending| {
                (pending.accepted || self.reoffer_pending)
                    && pending
                        .reoffered_from
                        .as_ref()
                        .is_some_and(|base| base.as_ref() == applied)
            }))
    }

    /// Take the view the runner applies as ck-mc's own: after a refusal, or
    /// when ck-mc's copy is missing or older (for example after a restore).
    pub(super) async fn adopt_runner_view<C: RunnerClient>(&mut self, client: &C) {
        if self.waiting_for_adoption() {
            return;
        }
        self.runner_reads
            .applied_view
            .fetch_add(1, Ordering::Relaxed);
        match client.applied_view(&self.key).await {
            Ok(answer) => {
                self.install_applied_view(client, answer).await;
            }
            Err(error) => {
                self.runner_reads
                    .applied_view_failed
                    .fetch_add(1, Ordering::Relaxed);
                self.runner_call_failed("session.applied_view", &error);
                if self.adoption_retry.is_some() {
                    self.defer_adoption();
                }
            }
        }
    }

    pub(super) async fn install_applied_view<C: RunnerClient>(
        &mut self,
        client: &C,
        answer: AppliedViewAnswer,
    ) {
        let own = answer
            .applied_by
            .as_deref()
            .is_none_or(|id| id == crate::MODULE_ID);
        let adopted = answer.view.as_ref().filter(|_| own);
        if let Some(view) = adopted {
            if !self
                .index_adopted_cut(client, move_floor::cut_of(view))
                .await
            {
                self.defer_adoption();
                return;
            }
        } else if let Some(before) = self.unconfirmed.first().map(|pending| pending.before.cut) {
            // A discarded offer may have pruned beyond the last confirmed
            // cut. Read back that suffix so stamps hidden by the offer can
            // land again. A confirmed cut can still be the host's marker.
            if !self.rewind_unconfirmed_cut(client, before).await {
                self.defer_adoption();
                return;
            }
        }
        self.adoption_retry = None;
        self.keep_spent_reading_for(&answer);
        // A restore can move the applied version backwards. Only the
        // runner's current view determines which readings are stale.
        self.newest_applied = answer.view.as_ref().map_or(0, |view| view.version);
        if !self.unconfirmed.is_empty() {
            let edited = lanes::Edited::of(adopted, &self.index, None);
            let pending = std::mem::take(&mut self.unconfirmed);
            self.restore_unconfirmed_stamps(&pending, |key| !edited.covers(&key.0, &key.1));
            let first_discarded = adopted
                .and_then(|view| pending.iter().position(|p| p.view == *view))
                .map_or(0, |at| at + 1);
            self.restore_unconfirmed_keep(&pending[first_discarded..]);
        }
        if let Some(view) = &answer.view {
            self.reset_transcript_retry();
            self.version = self.version.max(view.version);
            // A different provider owns its cut and edits. Only its
            // version is a floor for our whole replacement.
            if own {
                self.apply_cut(view);
                self.runner_applies_own_view(cuts(view));
            }
        }
        self.latest = answer.view.filter(|_| own);
        self.latest_unknown = false;
        self.app_adopt_head();
    }

    async fn rewind_unconfirmed_cut<C: RunnerClient>(
        &mut self,
        client: &C,
        cut: Option<u64>,
    ) -> bool {
        let base = cut
            .unwrap_or(1)
            .max(self.move_floor.as_ref().map_or(1, |floor| floor.ordinal));
        if base < self.index.base() {
            let before = std::mem::replace(&mut self.index, Index::starting_at(base));
            if !self
                .read_until_from(client, None, true, base.checked_sub(1).filter(|n| *n > 0))
                .await
            {
                self.index = before;
                return false;
            }
        }
        self.cut = cut;
        true
    }

    /// A runner restored to an earlier cut serves entries that the newer
    /// cut let us prune. Load them before making its view our current one.
    async fn index_adopted_cut<C: RunnerClient>(
        &mut self,
        client: &C,
        through: Option<&str>,
    ) -> bool {
        let base = match through {
            Some(mid) => {
                if self.index.ordinal_of(mid).is_some() {
                    return true;
                }
                let move_floor::Placed::At(ordinal) = self.place(client, mid).await else {
                    return false;
                };
                ordinal
            }
            None => self.move_floor.as_ref().map_or(1, |floor| floor.ordinal),
        };
        if base >= self.index.base() && through.is_none() {
            self.cut = None;
            return true;
        }
        let before = std::mem::replace(&mut self.index, Index::starting_at(base));
        let cut = self.cut;
        self.cut = through.map(|_| base);
        let ready = self.read_until(client, None, true).await
            && through.is_none_or(|mid| self.index.ordinal_of(mid) == Some(base));
        if !ready {
            self.cut = cut;
            self.index = before;
            return false;
        }
        if through.is_some() {
            self.cut = cut;
        }
        self.app_projection.render_changed();
        true
    }

    pub(super) fn waiting_for_adoption(&self) -> bool {
        self.adoption_retry
            .is_some_and(|(due, _)| due > tokio::time::Instant::now())
    }

    pub(super) fn defer_adoption(&mut self) {
        self.latest_unknown = true;
        self.index_ready = false;
        let attempt = self
            .adoption_retry
            .map_or(0, |(_, attempt)| (attempt + 1).min(5));
        let delay = std::time::Duration::from_millis(250 << attempt);
        self.adoption_retry = Some((tokio::time::Instant::now() + delay, attempt));
    }
}
