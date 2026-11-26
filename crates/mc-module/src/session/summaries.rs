//! The summaries a session holds: loading them from `context.db`, forgetting
//! them after a revert, holding a session whose transcript is behind them, and
//! the cut they allow.

use super::*;

impl Session {
    /// Whether the session holds all its summaries: false while those of a
    /// session resumed after a quiet free could not be read from `context.db`
    /// again, which leaves only the newest. Each call while they are unread
    /// tries the read again; once it succeeds the session is checked against
    /// them as after a restart. Nothing may run on the partial set.
    pub(crate) fn summaries_ready(&mut self) -> bool {
        if self.summaries_unread && self.reload_quiet_summaries() {
            self.summaries_unread = false;
            let cut = self.cut;
            self.distrust_state_ahead_of_summaries();
            if self.cut != cut {
                self.index = Index::starting_at(self.cut.unwrap_or(1));
                self.index_ready = false;
            }
        }
        !self.summaries_unread
    }

    /// Drop the summaries of a session freed while quiet, all but the
    /// newest ([`QuietCarry::pre_user`] reads it). With
    /// [`Session::reload_quiet_summaries`], the only places freeing a session
    /// touches its summaries. Without `context.db` (only tests run so) the
    /// summaries live only in memory, and are kept.
    pub(super) fn drop_quiet_summaries(&mut self) {
        if self.db.is_none() {
            return;
        }
        // The index stays whole; only the held rows older than the newest
        // are let go, and the resume reads every row again.
        if let Some(newest) = self.summaries.last().map(|summary| summary.sequence) {
            self.summaries.release_through(newest - 1);
        }
    }

    /// Read the summaries of a session resumed after a quiet free again, as
    /// [`Session::load_summaries`] does; false, with the summaries left as
    /// they were, when `context.db` can't be read.
    fn reload_quiet_summaries(&mut self) -> bool {
        let Some(db) = &self.db else {
            return true;
        };
        match db.compartments(&self.key.harness, &self.key.session) {
            Ok(summaries) => {
                self.summaries.replace(summaries);
                self.app_projection.summaries_dirty = true;
                true
            }
            Err(error) => {
                tracing::warn!(
                    session = %self.key.session,
                    %error,
                    "ck-mc: session: reading its summaries again after a quiet free failed; nothing runs on it until a read succeeds"
                );
                false
            }
        }
    }

    /// `sessions.db` and `context.db` are backed up separately, and a restore
    /// can pair this store with an older `context.db` (a night whose
    /// `context.db` capture failed keeps the previous one). Restored state
    /// may then cut, or show in `m[0]`, summaries `context.db` no longer
    /// has; those messages would be neither summarized nor shown. ck-mc
    /// trusts `context.db`: reading starts where its summaries end, `m[0]` is
    /// rendered again ([`Session::adopt_stored_summaries`]), views not yet
    /// confirmed are dropped, and the next view moves the cut back, so the
    /// summarizer covers those messages again.
    pub(super) fn distrust_state_ahead_of_summaries(&mut self) {
        let (cut, covered) = (self.cut, self.summarized_through());
        if !self.adopt_stored_summaries() {
            return;
        }
        tracing::info!(
            session = %self.key.session,
            ?cut,
            ?covered,
            "ck-mc: session: saved state is ahead of context.db's summaries; rebuilding from context.db"
        );
        // Views saved before the restart may rest on those summaries too.
        // Setup reads back the one the runner applies before any is built.
        self.unconfirmed.clear();
        self.latest = None;
    }

    /// Take the summaries `context.db` holds, which `load_summaries` has
    /// just read, over state that rests on summaries it no longer has. The
    /// cut moves back to where the summaries end, and the transcript is read
    /// again from there when the index no longer holds it. A baseline that
    /// shows summaries past them is dropped, so the head folds. Then the text
    /// no baseline needs is let go. A restore comes here, and so does a
    /// build after a head render found summaries missing from `context.db`
    /// ([`Session::reload_changed_summaries`]). Returns whether the state was
    /// ahead of the summaries.
    fn adopt_stored_summaries(&mut self) -> bool {
        let covered = self.summarized_through();
        let cut_ahead = self
            .cut
            .is_some_and(|cut| covered.is_none_or(|covered| cut > covered));
        // A baseline folded before any summary records -1, the same value
        // as no summaries in context.db: that pair is consistent, not ahead.
        let last_sequence = self.summaries.last().map_or(-1, |summary| summary.sequence);
        let head_ahead = self
            .baseline
            .as_ref()
            .is_some_and(|baseline| baseline.through_sequence > last_sequence);
        if cut_ahead {
            self.cut = covered;
            let from = self.cut.unwrap_or(1);
            if self.index.base() > from {
                self.index = Index::starting_at(from);
                self.index_ready = false;
            }
        }
        if head_ahead {
            self.baseline = None;
        }
        self.head_stale |= cut_ahead || head_ahead;
        self.release_summary_bodies();
        cut_ahead || head_ahead
    }

    /// A head render found summaries `context.db` no longer holds: another
    /// writer deleted them after the session let their text go. ck-mc
    /// trusts `context.db`, so the session reads its summaries from there
    /// again and takes them over the state that rested on the missing ones
    /// ([`Session::adopt_stored_summaries`]); the due fold then renders from
    /// what remains. Views the runner holds stay: the next one carries
    /// their edits and moves the cut back if it has to.
    pub(super) fn reload_changed_summaries(&mut self) {
        let Some(missing) = self.summaries_missing.take() else {
            return;
        };
        tracing::warn!(
            session = %self.key.session,
            missing_ids = ?missing,
            "ck-mc: session: some summaries are no longer in context.db; the session reads its summaries from there again"
        );
        self.load_summaries();
        self.adopt_stored_summaries();
    }

    /// Load the summaries `context.db` already holds for the session, such as
    /// those of a session moved in from a standalone host. Every row is held
    /// until the session knows which its history head still needs
    /// ([`Session::release_summary_bodies`]).
    pub fn load_summaries(&mut self) {
        let Some(db) = &self.db else {
            return;
        };
        match db.compartments(&self.key.harness, &self.key.session) {
            Ok(summaries) => {
                self.summaries.replace(summaries);
                self.app_projection.summaries_dirty = true;
            }
            Err(error) => tracing::warn!(
                session = %self.key.session,
                %error,
                "ck-mc: session: loading summaries failed"
            ),
        }
    }

    /// Every summary's index entry, oldest first.
    pub(crate) fn summary_index(&self) -> &[SummaryIndex] {
        &self.summaries
    }

    /// Every summary's full row, oldest first: held ones copied from memory,
    /// the others read from `context.db`.
    pub(crate) fn summary_rows(&self) -> Result<Vec<StoredCompartment>, UnreadSummaries> {
        let rows = self
            .summaries
            .rows(0..self.summaries.len(), self.summary_store())
            .map_err(UnreadSummaries::Failed)?;
        if !rows.missing.is_empty() {
            return Err(UnreadSummaries::Missing(rows.missing));
        }
        Ok(rows.found.into_iter().map(Arc::unwrap_or_clone).collect())
    }

    /// Where the summaries the session doesn't hold are read from.
    pub(super) fn summary_store(&self) -> Option<(&ContextDb, &str, &str)> {
        self.db
            .as_deref()
            .map(|db| (db, self.key.harness.as_str(), self.key.session.as_str()))
    }

    /// Stop holding the text of summaries that no baseline the session may
    /// still render `m[1]` against shows there: neither its own nor the one
    /// an unconfirmed view would restore. A baseline shows in `m[1]` only
    /// the summaries newer than it, and a state without one folds, which
    /// reads every summary from `context.db`. With none at all, or without
    /// a store to read them back from, every row stays.
    pub(super) fn release_summary_bodies(&mut self) {
        if self.db.is_none() {
            return;
        }
        let through = self
            .baseline
            .iter()
            .chain(
                self.unconfirmed
                    .iter()
                    .filter_map(|pending| pending.before.baseline.as_ref()),
            )
            .map(|baseline| baseline.through_sequence)
            .min();
        if let Some(through) = through {
            self.summaries.release_through(through);
        }
    }

    /// A store load decodes each saved baseline on its own, so the
    /// session's baseline and each unconfirmed view's before-state hold
    /// separate copies of what is usually the same text: the frozen part of
    /// the history head (`m[0]`, the summaries, memories and docs rendered at
    /// the last fold). Keep one.
    pub(super) fn share_baseline_text(&mut self) {
        let mut kept: Vec<Arc<str>> = self
            .baseline
            .iter()
            .map(|baseline| baseline.m0.clone())
            .collect();
        for pending in &mut self.unconfirmed {
            let Some(baseline) = &mut pending.before.baseline else {
                continue;
            };
            match kept.iter().find(|m0| **m0 == baseline.m0) {
                Some(m0) if !Arc::ptr_eq(m0, &baseline.m0) => {
                    Arc::make_mut(baseline).m0 = m0.clone();
                }
                Some(_) => {}
                None => kept.push(baseline.m0.clone()),
            }
        }
    }

    /// After a revert removed messages from `ordinal` on, forget the summaries
    /// that cover any of them, as the standalone plugin does when its host
    /// reverts. If the history head showed one of them, it is rendered again
    /// from the summaries that remain.
    pub(super) fn forget_summaries_from(&mut self, ordinal: u64) {
        let Some(first) = self
            .summaries
            .iter()
            .position(|summary| summary.end_message as u64 >= ordinal)
        else {
            return;
        };
        let sequence = self.summaries[first].sequence;
        let shown = self.baseline.is_some()
            || self
                .latest
                .as_ref()
                .is_some_and(|view| view.edits.iter().any(|edit| head::is_head(&edit.op)));
        if let Some(db) = &self.db {
            if let Err(error) =
                db.delete_compartments_from(&self.key.harness, &self.key.session, sequence)
            {
                tracing::warn!(
                    session = %self.key.session,
                    %error,
                    "ck-mc: session: deleting reverted summaries failed"
                );
            }
        }
        self.summaries.truncate(first);
        self.app_projection.summaries_dirty = true;
        // `m[0]` is rendered again only when it shows a forgotten summary;
        // one shown only in `m[1]` leaves with an `m[1]` refresh, and `m[0]`
        // stays cached.
        if self
            .baseline
            .as_ref()
            .is_none_or(|baseline| sequence <= baseline.through_sequence)
        {
            self.baseline = None;
        }
        self.head_stale |= shown;
    }

    /// A runner-reported revert (`TranscriptChanged`). The notice may be
    /// acknowledged before its revert runs, or arrive after a read already
    /// saw the replacement branch, so the summary endpoints are validated
    /// against the current transcript rather than deleted by a stale event.
    /// Every summary from `from` on whose last message is gone is forgotten.
    pub(super) async fn reconcile_reverted_summaries<C: RunnerClient>(
        &mut self,
        client: &C,
        from: u64,
    ) -> bool {
        let Some(walk) = self.walk_summaries(client, from, true, None).await else {
            return false;
        };
        if let Some(ordinal) = walk.invalid_from {
            self.invalidate_transcript_from(ordinal);
        }
        true
    }

    /// The check made when no revert was reported: at Setup, and before each
    /// notice and ride while the session is held. Walks from the newest
    /// summary as a reported revert does, and permits forgetting the
    /// summaries that failed only while there are at most
    /// [`IMPLICIT_FORGET_LIMIT`] of them. It reads at most one message more
    /// than that limit.
    pub(super) async fn check_summaries<C: RunnerClient>(&self, client: &C) -> SummaryCheck {
        let Some(walk) = self
            .walk_summaries(client, 1, false, Some(IMPLICIT_FORGET_LIMIT + 1))
            .await
        else {
            return SummaryCheck::ReadFailed;
        };
        if walk.failed <= IMPLICIT_FORGET_LIMIT {
            SummaryCheck::Whole {
                forget_from: walk.invalid_from,
            }
        } else {
            SummaryCheck::Behind {
                failed: walk.failed,
            }
        }
    }

    /// Walk the summaries that cover `from` or later, newest first, reading
    /// from the runner, by id, the message each one ends on. The walk stops
    /// at the first summary whose message is still there at its position,
    /// or after `give_up_after` summaries failed. Without a reported revert
    /// (`explicit_revert` false), a summary that lacks that message's id
    /// (older rows may) also stops it: missing metadata alone is not
    /// evidence of a revert. `None` when a read failed.
    async fn walk_summaries<C: RunnerClient>(
        &self,
        client: &C,
        from: u64,
        explicit_revert: bool,
        give_up_after: Option<usize>,
    ) -> Option<SummaryWalk> {
        let mut walk = SummaryWalk {
            invalid_from: None,
            failed: 0,
        };
        for summary in self
            .summaries
            .iter()
            .rev()
            .filter(|summary| summary.end_message as u64 >= from)
        {
            if give_up_after.is_some_and(|limit| walk.failed >= limit) {
                break;
            }
            if summary.end_message_id.is_empty() {
                if !explicit_revert {
                    break;
                }
                walk.invalid_from = Some(summary.start_message as u64);
                walk.failed += 1;
                continue;
            }
            let read = crate::reads::named_detail(
                client,
                &self.key,
                vec![summary.end_message_id.clone()],
                self.limits,
                Detail::Compact,
                |mids| Select::Mids { mids },
            )
            .await;
            self.count_read(read.as_ref().ok().map(Vec::len));
            let entries = match read {
                Ok(entries) => entries,
                Err(error) => {
                    if !error.message.starts_with("runner fault:") {
                        tracing::warn!(
                            session = %self.key.session,
                            ?error,
                            "ck-mc: session: reconciling summaries failed"
                        );
                    }
                    return None;
                }
            };
            if entries.iter().any(|entry| {
                entry.mid == summary.end_message_id && entry.ordinal == summary.end_message as u64
            }) {
                break;
            }
            walk.invalid_from = Some(summary.start_message as u64);
            walk.failed += 1;
        }
        Some(walk)
    }

    /// Hold the session: the transcript does not hold the messages its
    /// summaries end on, and no reported revert explains it. Nothing is
    /// forgotten, and the state stays as it is; see `transcript_behind` for
    /// what a held session does. Logged once per hold, when it begins.
    pub(super) fn hold_transcript_behind(&mut self, failed: usize, runner_newest: Option<&Cursor>) {
        self.index_ready = false;
        if let Some(checks) = &mut self.transcript_behind {
            *checks += 1;
            return;
        }
        self.transcript_behind = Some(1);
        let (end, end_id) = self.summaries.last().map_or((0, ""), |summary| {
            (summary.end_message, summary.end_message_id.as_str())
        });
        let runner = runner_newest.map_or_else(
            || "not named".to_owned(),
            |cursor| format!("entry {} ({})", cursor.ordinal, cursor.mid),
        );
        tracing::error!(
            session = %self.key.session,
            failed_count = failed,
            summary_count = self.summaries.len(),
            check_limit = IMPLICIT_FORGET_LIMIT + 1,
            end_ordinal = end,
            end_mid = %end_id,
            newest = %runner,
            "ck-mc: session: transcript_behind_summaries: summaries end on messages the transcript no longer holds at their position, and the runner reported no revert. Nothing is forgotten; the session reads, builds and summarizes nothing until a check finds those messages again"
        );
    }

    /// A check passed: a held session resumes. Logged under the same name
    /// as the hold, so the log shows where each hold ends.
    pub(super) fn release_transcript_hold(&mut self) {
        if let Some(checks) = self.transcript_behind.take() {
            tracing::info!(
                session = %self.key.session,
                failed_count = %checks,
                "ck-mc: session: transcript_behind_summaries: the transcript holds the summaries' messages again; the session resumes"
            );
        }
    }

    /// A notice or ride for a held session checks the summaries again first.
    /// When the check passes, the session leaves the hold and does what
    /// Setup skipped while it was held: views are settled and offered again,
    /// and the summaries a missed revert reached are forgotten. The index is
    /// left not ready, so the caller reads the transcript again from the
    /// cut. Returns whether the session resumed.
    pub(super) async fn resume_if_transcript_whole<C: RunnerClient>(
        &mut self,
        client: &C,
        applied: StatedView<'_>,
        runner_newest: Option<&Cursor>,
    ) -> bool {
        let forget_from = match self.check_summaries(client).await {
            SummaryCheck::Whole { forget_from } => forget_from,
            SummaryCheck::Behind { failed } => {
                self.hold_transcript_behind(failed, runner_newest);
                return false;
            }
            SummaryCheck::ReadFailed => return false,
        };
        self.release_transcript_hold();
        self.settle_stated(applied, &[]);
        self.load_move_floor(client).await;
        self.judge_acceptance_afresh();
        self.offer_unconfirmed_again(client, applied).await;
        if let Some(ordinal) = forget_from {
            self.invalidate_transcript_from(ordinal);
        }
        // Changes the background indexer may have missed while the session
        // was held are reconciled from the cut, as after a Setup.
        let base = self.cut.unwrap_or(1);
        self.search_reconcile_from =
            Some(self.search_reconcile_from.map_or(base, |old| old.min(base)));
        true
    }

    /// A ride for a held session: check the summaries again, and once they
    /// pass, read the transcript now. A ride itself builds only from what
    /// the index holds, and the session resumes in this pass.
    pub async fn before_ride<C: RunnerClient>(&mut self, client: &C, ride: &RideRequest) {
        // Whether the ride belongs to the session as ck-mc holds it comes
        // first, before anything in it is taken. A ride from another epoch
        // is logged by `ride`, which sees it next.
        let Some(standing) = self.standing(&ride.conditions) else {
            return;
        };
        if self.transcript_behind.is_none() || self.suspended {
            return;
        }
        let stated = StatedView::of(standing, ride.applied_view.as_ref());
        if !self.resume_if_transcript_whole(client, stated, None).await {
            return;
        }
        self.index = Index::starting_at(self.cut.unwrap_or(1));
        self.index_ready = self.read_until(client, None, true).await;
        if self.index_ready && self.runner_differs(self.judged_view(stated).as_ref()) {
            self.adopt_runner_view(client).await;
        }
    }

    pub(super) fn invalidate_transcript_from(&mut self, ordinal: u64) {
        self.forget_summaries_from(ordinal);
        self.index.truncate(ordinal);
        self.app_projection.revert(ordinal);
        if self.cut.is_some_and(|cut| ordinal <= cut) {
            self.cut = self.summarized_through();
            self.index = Index::starting_at(self.cut.unwrap_or(1));
        }
        self.search_dirty_from = Some(
            self.search_dirty_from
                .map_or(ordinal, |old| old.min(ordinal)),
        );
    }

    /// The id of the last message a summary covers.
    pub fn last_summary_end(&self) -> Option<String> {
        self.summaries
            .last()
            .map(|summary| summary.end_message_id.clone())
    }

    pub fn last_summary_ordinal(&self) -> Option<u64> {
        self.summarized_through()
    }

    /// The last ordinal a summary covers. Summaries name messages by
    /// ordinal, which counts from 1.
    pub(super) fn summarized_through(&self) -> Option<u64> {
        self.summaries
            .last()
            .map(|summary| summary.end_message as u64)
    }

    /// The ordinal the latest view's cut reaches: messages up to it are
    /// replaced by the history head.
    pub(super) fn cut_ordinal(&self) -> Option<u64> {
        self.cut
    }

    /// Take `view`'s cut as the applied one, and forget the index before it.
    /// A cut message the index does not hold (a view adopted after a restart)
    /// leaves the known cut as it is.
    pub(super) fn apply_cut(&mut self, view: &View) {
        let through = view.edits.iter().find_map(|edit| match &edit.op {
            EditOp::Cut { through } => Some(through),
            _ => None,
        });
        let Some(ordinal) = through.and_then(|through| {
            self.index
                .entries()
                .iter()
                .find(|entry| &entry.mid == through)
                .map(|entry| entry.ordinal)
        }) else {
            return;
        };
        // A cut ends where a summary ends. A runner's cut past the summaries
        // `context.db` holds comes from state newer than it (see
        // `distrust_state_ahead_of_summaries`): the index keeps those
        // messages, and the next view moves the cut back.
        if self
            .summarized_through()
            .is_none_or(|covered| ordinal > covered)
        {
            if self.numbers_reach().is_none_or(|reach| ordinal > reach) {
                self.head_stale = true;
            }
            return;
        }
        self.cut = Some(ordinal);
        let gone = self.index.prune_before(ordinal);
        self.app_persist_cut(&gone);
        self.pruned_turns += crate::nudges::person_turns(&gone);
    }
}
