//! Notices: what the runner reports between requests, and the pass each one
//! runs.

use super::*;

impl Session {
    /// Handle a notice. Returns a summarizer run for the worker to start, when
    /// one is due. After the pass, the `ctx_reduce` reminders read what the
    /// model now sees.
    pub async fn notice<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        notice: NoticeRequest,
    ) -> Option<run::Request> {
        let _timing = crate::notice_cost_timing::span("session.notice");
        // Summaries a resume could not read again are read first; until
        // then the notice takes nothing (the worker holds it meanwhile).
        if !self.summaries_ready() {
            return None;
        }
        // Whether the notice belongs to the session as ck-mc holds it comes
        // first, before anything in it is taken, the notice number included.
        let Some(standing) = self.standing(&notice.conditions) else {
            self.log_foreign("notice", &notice.conditions);
            return None;
        };
        // Not newer than the last notice handled since Setup (compaction contract N5). Setup sets
        // the count to 0 and a runner's first notice after it is 1, so this
        // also ignores a notice numbered 0.
        if notice.seq <= self.seq || self.suspended {
            return None;
        }
        // A held session does nothing else until its summaries pass the
        // check again.
        let stated = StatedView::of(standing, notice.applied_view.as_ref());
        if self.transcript_behind.is_some()
            && !self
                .resume_if_transcript_whole(client, stated, notice.newest.as_ref())
                .await
        {
            return None;
        }
        let version = self.latest.as_ref().map(|view| view.version);
        let cut = self.cut_ordinal();
        let summary = self.handle_notice(client, settings, notice, standing).await;
        if !self.index_ready {
            return summary;
        }
        let rebuilt = self.latest.as_ref().map(|view| view.version) != version;
        let cut_moved = self.cut_ordinal() > cut;
        self.remind(client, settings, rebuilt, cut_moved).await;
        summary
    }

    async fn handle_notice<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        notice: NoticeRequest,
        standing: Standing,
    ) -> Option<run::Request> {
        let _timing = crate::notice_cost_timing::span("session.handle_notice");
        self.seq = notice.seq;
        self.note_transcript_growth(notice.newest.as_ref());
        let previous = reading_of(&self.conditions);
        let previous_notes = self.notes.measured;
        let was_stale = self.reading_stale;
        self.take_conditions("notice", standing, &notice.conditions);
        if standing == Standing::Current {
            self.notes.notice(
                notice.conditions.notes_tokens,
                notice.token_family.as_deref(),
            );
            self.surface_tokens = (
                notice.conditions.system_tokens,
                notice.conditions.tools_tokens,
            );
        }
        let stated = StatedView::of(standing, notice.applied_view.as_ref());
        self.threshold = (
            settings.execute_threshold_percentage,
            settings.execute_threshold_source,
        );
        self.warn_if_prompt_size_missing(&notice.entries);
        // What the runner says about the views it took comes first: a
        // rollback restores the state before the events below change it.
        let refused: Vec<_> = notice
            .events
            .iter()
            .filter_map(|event| match event {
                Event::ViewRefused { refusal: ViewRefusal::RenderFailed { .. }, .. } => None,
                Event::ViewRefused { version, refusal } => {
                    // A runner can take a view and refuse it later, at the
                    // step it would first serve it. The reason is the only
                    // record of why the view's work was undone.
                    tracing::warn!(
                        "ck-mc: session {}: runner refused view {version} at a step boundary: {refusal:?}",
                        self.key.session
                    );
                    Some((*version, refusal.clone()))
                }
                _ => None,
            })
            .collect();
        // ck-mc's newest view, which the runner holds or was handed before
        // this notice.
        let held = self.latest.as_ref().map(|view| view.version);
        self.settle_stated(stated, &refused);
        // A view is offered again now if its offer after a restart waited
        // because the runner couldn't place the view's cut (the point before
        // which the view leaves the session's messages out), or if the
        // answer to applying it was lost.
        if self.reoffer_pending {
            self.offer_unconfirmed_again(client).await;
        }
        self.rebuild_when_runner_lost_view(held);
        self.take_render_failures(&notice.events);
        let judged = self.judged_view(stated);
        match standing {
            Standing::Current => self.judge_reading(previous, judged.as_ref()),
            Standing::Older { .. } => self.judge_held_reading(was_stale, judged.as_ref()),
        }
        if self.reading_stale {
            // The apps keep the last current reading; its notes attribution
            // must stay with it while the newest notice's pending count advances.
            self.notes.measured = previous_notes;
        }
        for event in &notice.events {
            match event {
                Event::TranscriptChanged { from_ordinal } => {
                    self.search_dirty_from = Some(
                        self.search_dirty_from
                            .map_or(*from_ordinal, |old| old.min(*from_ordinal)),
                    );
                    if !self
                        .reconcile_reverted_summaries(client, *from_ordinal)
                        .await
                    {
                        self.index_ready = false;
                        return None;
                    }
                    if self
                        .summaries
                        .last()
                        .is_some_and(|summary| summary.end_message as u64 >= *from_ordinal)
                    {
                        // A summary on the replacement branch already covers
                        // the change; the delayed event must not erase it or
                        // its search rows.
                        continue;
                    }
                    self.app_projection.revert(*from_ordinal);
                    self.index.truncate(*from_ordinal);
                    self.clamp_bookmark_to_held();
                    if self.cut.is_some_and(|cut| *from_ordinal <= cut) {
                        // The undo reached the cut message or before it, and
                        // the summaries of what it removed are gone. The next
                        // view cuts at the last summary left; the index is
                        // read again from there.
                        self.cut = self.summarized_through();
                        self.index = Index::starting_at(self.cut.unwrap_or(1));
                    }
                }
                Event::ViewRefused { .. } => {}
                Event::MarkerWritten { .. } => {}
                // An event the contract may add later: its reach is unknown,
                // so the index is read again from the cut, the oldest message
                // the model still sees (compaction contract W1.5).
                other => {
                    tracing::info!(
                        "ck-mc: session {}: unknown notice event {other:?}; reading the transcript again",
                        self.key.session
                    );
                    self.index = Index::starting_at(self.cut.unwrap_or(1));
                }
            }
        }
        // A notice leaves its entries out when they are too large (compaction contract W5.2), and
        // then a change to an older message is not in it either: read from
        // the oldest entry that may have changed.
        let omitted = notice.entries.is_empty();
        let changed_from = if omitted {
            self.index.changeable_from()
        } else {
            notice
                .entries
                .first()
                .filter(|e| self.index.cursor().is_some_and(|c| e.ordinal <= c.ordinal))
                .map(|e| e.ordinal)
        };
        if let Some(from) = changed_from
            .into_iter()
            .chain(notice.entries.first().map(|entry| entry.ordinal))
            .min()
        {
            self.search_reconcile_from =
                Some(self.search_reconcile_from.map_or(from, |old| old.min(from)));
        }
        // No newest entry: the transcript is empty, and the read empties the
        // index.
        let extended = self
            .index
            .extend_counted(notice.entries, notice.token_family.as_deref());
        if extended == Extend::Diverged {
            self.app_projection.revert(self.index.base());
        }
        if extended == Extend::Diverged || !self.index_ready {
            let held_before: Vec<(u64, String)> = self
                .index
                .entries()
                .iter()
                .map(|entry| (entry.ordinal, entry.mid.clone()))
                .collect();
            self.index = Index::starting_at(self.cut.unwrap_or(1));
            self.index_ready = self.read_until(client, notice.newest.as_ref(), true).await;
            // A read that held the session keeps its state as it was.
            if extended == Extend::Diverged && self.transcript_behind.is_none() {
                // A change with no event: clamp to what the new transcript
                // still shares with the old one.
                let shared = self
                    .index
                    .entries()
                    .iter()
                    .take_while(|entry| {
                        held_before
                            .iter()
                            .any(|(ordinal, mid)| *ordinal == entry.ordinal && *mid == entry.mid)
                    })
                    .count();
                self.clamp_bookmark_to(shared);
            }
        } else if extended == Extend::Gap || !self.index.ends_at(notice.newest.as_ref()) {
            self.index_ready = self.sync(client, notice.newest.as_ref()).await;
        } else if let Some(newest) = notice.newest.as_ref().filter(|_| omitted) {
            self.index_ready = self.sync_from_changeable(client, newest).await;
        }
        if !self.index_ready {
            self.log_render_location(&notice.events);
            return None;
        }
        self.log_window_budget();
        self.take_signed_floor();
        // A view the runner applies that ck-mc does not expect (it lost one,
        // or restored an older one) is taken as ck-mc's own. After the read,
        // so the view's cut message is in the index.
        if self.runner_differs(self.judged_view(stated).as_ref()) {
            self.adopt_runner_view(client).await;
            self.rebuild_when_runner_lost_view(held);
            // The reading was judged before ck-mc knew its own newest view.
            let judged = self.judged_view(stated);
            match standing {
                Standing::Current => {
                    if self.judge_spent_reading_after_adoption(previous, judged.as_ref()) {
                        self.notes.measured = previous_notes;
                    }
                }
                Standing::Older { .. } => self.judge_held_reading(was_stale, judged.as_ref()),
            }
        }
        let render_repeat =
            self.settle_render_failures(&notice.events, self.judged_view(stated).as_ref());
        self.log_render_location(&notice.events);
        self.forget_missing();
        if render_repeat {
            return None;
        }
        // A stale reading changes no pressure state: the emergency latch and
        // the `ctx_keep` request stay as the last current reading left them.
        // Released on a reading that says nothing about usage, the latch would
        // let the next reading in the force band take a second emergency
        // batch right after the view that took the first. A late statement
        // brought no reading, so it changes none either.
        if !self.reading_stale && standing == Standing::Current {
            if !pass::in_force_band(&self.conditions, settings) {
                self.emergency_latched = false;
            }
            let execute = pass::at_execute(&self.conditions, settings);
            if !execute {
                self.keep_requested = false;
            }
        }
        // A `ctx_keep` waits while the summaries stop short of the move floor:
        // no view can land it then, and the pass below must still be free to
        // start the summary that reaches the floor again.
        if self.render_failed.repair_pending {
            self.fold_due = true;
        }
        let short_of_move_floor = self.short_of_move_floor() || self.short_of_numbers_floor();
        if let Some(kept) = self
            .pending_keep
            .take_if(|_| !self.latest_unknown && !short_of_move_floor)
        {
            let (view, _) = self.build(settings, None, false, Some(&kept));
            if let Some(view) = view {
                self.publish(client, view).await;
            }
            self.keep_requested = false;
            return None;
        }
        let decision = self.decide_notice(settings);
        if decision.rebuild || self.render_failed.repair_pending {
            let (view, freed) = if self.render_failed.repair_pending {
                // The runner already serves raw history: all queued work may
                // land in the same rebuild, as on a fold.
                self.fold_due = true;
                self.build(settings, None, true, None)
            } else {
                self.build_now(client, settings).await
            };
            if let Some(view) = view {
                if decision.lost_view {
                    self.record_lost_view_offer(&view);
                }
                self.publish(client, view).await;
            }
            if !decision.head_stale {
                self.ask_for_keep_if_short(client, settings, freed).await;
            }
        }
        decision.summary
    }

    /// The runner applies no view now, though before this notice it held or
    /// was handed ck-mc's view `held`: it refused ck-mc's newest view at a
    /// step boundary, or dropped the view it applied, as a runner does when
    /// an undo removes the view's cut message or a step finds the view's
    /// window stale. When that view was itself offered because the runner
    /// lost an earlier one, its end counts toward the bound on such offers.
    /// A session past its host's compaction marker (written at an applied
    /// view's cut, after which the host no longer loads the messages before
    /// it), or moved in from another host, takes no step until a view
    /// applies, so a view is due whatever the usage (`lost_view_due`). Only a
    /// session whose host may hold such a marker counts (`marker_possible`):
    /// a first view refused before any view applied is an ordinary refusal.
    /// Only a session with a summarizer renders a head, and only one with
    /// summaries or a cut has history to serve again.
    fn rebuild_when_runner_lost_view(&mut self, held: Option<u64>) {
        let Some(version) = held else {
            return;
        };
        if self.latest.is_some() || self.latest_unknown || self.newest_applied != 0 {
            return;
        }
        self.lost_view_offer_ended(version);
        if self.lost_view_due
            || !self.marker_possible
            || !self.features.summarizer
            || (self.summaries.is_empty() && self.cut.is_none())
        {
            return;
        }
        tracing::info!(
            "ck-mc: session {}: the runner applies no view after ck-mc's view {version}; the history head is rebuilt and offered on this notice",
            self.key.session
        );
        self.lost_view_due = true;
    }

    /// Whether this notice builds and offers a view because the runner lost
    /// ck-mc's view (`lost_view_due`): while ck-mc holds no view of its own,
    /// the runner applies none, and fewer than [`LOST_VIEW_OFFERS`] such
    /// views ended refused or dropped in a row.
    fn lost_view_forced(&self) -> bool {
        self.lost_view_due
            && self.latest.is_none()
            && !self.latest_unknown
            && self.newest_applied == 0
            && self.lost_view_offers < LOST_VIEW_OFFERS
    }

    /// `view` is offered because the runner lost ck-mc's view.
    pub(super) fn record_lost_view_offer(&mut self, view: &View) {
        self.lost_view_offer = Some(LostViewOffer {
            version: view.version,
            through: self.index.cursor().map_or(0, |cursor| cursor.ordinal),
            ended: false,
        });
    }

    /// The views from `from` on were refused, or the runner dropped `from`.
    /// When they include the newest view offered because the runner lost
    /// ck-mc's view, and no new message came since it was built (a new one
    /// drops the record, see [`Session::note_transcript_growth`]), it counts
    /// toward [`LOST_VIEW_OFFERS`]. Reaching the bound is logged once.
    pub(super) fn lost_view_offer_ended(&mut self, from: u64) {
        let Some(offer) = self
            .lost_view_offer
            .as_mut()
            .filter(|offer| !offer.ended && offer.version >= from)
        else {
            return;
        };
        offer.ended = true;
        self.lost_view_offers += 1;
        if self.lost_view_offers == LOST_VIEW_OFFERS {
            tracing::warn!(
                "ck-mc: session {}: the runner refused or dropped {} views in a row that ck-mc offered because the runner applied none of its views, with no new message since; none is forced until the transcript grows or the next Setup, and a view waits for a summary or for the usage to call for one",
                self.key.session,
                self.lost_view_offers
            );
        }
    }

    /// A message newer than the one the newest view offered because the
    /// runner lost ck-mc's view was built through: that view's end no longer
    /// counts, and such views may be offered again.
    pub(super) fn note_transcript_growth(&mut self, newest: Option<&Cursor>) {
        if let (Some(offer), Some(newest)) = (self.lost_view_offer, newest) {
            if newest.ordinal > offer.through {
                self.lost_view_offer = None;
                self.lost_view_offers = 0;
            }
        }
    }

    /// The runner reports applying ck-mc's view, which `cuts` or not: no view
    /// is due for a lost one, and one that cuts may leave a compaction
    /// marker in the host.
    pub(super) fn runner_applies_own_view(&mut self, cuts: bool) {
        self.lost_view_due = false;
        self.marker_possible |= cuts;
    }

    /// One permission for the history refresh and every mutation lane. Summary
    /// admission runs first, so a run started here also holds the queued work.
    /// A view due because the runner lost ck-mc's view is offered on a notice
    /// only, never on a ride.
    pub(super) fn decide_notice(&mut self, settings: &Settings) -> NoticePass {
        let _timing = crate::notice_cost_timing::span("notice.decision");
        let summary = self.summary_due(settings);
        let lost_view = self.lost_view_forced();
        NoticePass {
            summary,
            rebuild: self.rebuild_permitted(settings) || lost_view,
            head_stale: self.head_stale,
            lost_view,
        }
    }
}
