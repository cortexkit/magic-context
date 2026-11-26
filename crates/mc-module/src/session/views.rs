//! Rides, and building and sealing the views a pass produces.

use super::*;

enum Sealed {
    Done(Option<View>),
    RetryWithoutCut,
}

/// What [`Session::emergency_served`] finds the request costs.
pub(super) struct EmergencyServed {
    /// Each part as the new view would serve it.
    pub(super) parts: std::collections::BTreeMap<lanes::PartKey, u64>,
    /// The history head of the new view.
    pub(super) head: u64,
    /// Every part and the head, under the new view.
    pub(super) total: i64,
    /// The same under ck-mc's newest view.
    pub(super) previous_total: i64,
}

impl Session {
    /// A ride: the runner is about to send a request whose bytes before the
    /// conversation change anyway, or that would not fit, or whose cache the
    /// provider forgot. The first two land everything held now; the last
    /// lands only what the pass would land on a notice, as does a soft window
    /// budget signal (see [`pass::RideCauseKind`]).
    pub fn ride(&mut self, settings: &Settings, ride: &RideRequest) -> Option<View> {
        // No view is built on summaries a resume could not read again.
        if !self.summaries_ready() {
            return None;
        }
        // Whether the ride belongs to the session as ck-mc holds it comes
        // first, before anything in it is taken.
        let Some(standing) = self.standing(&ride.conditions) else {
            self.log_foreign("ride", &ride.conditions);
            return None;
        };
        if !self.index_ready || self.suspended {
            return None;
        }
        let previous = reading_of(&self.conditions);
        let was_stale = self.reading_stale;
        self.take_conditions("ride", standing, &ride.conditions);
        // Rides carry no surface counts (compaction contract W4.11), so the
        // held ones describe what was sent before a change a ride reports,
        // until a notice brings fresh ones. A ride built after the notice
        // they came from says so even when it arrives after a newer
        // statement.
        if ride.has(RideCause::SurfaceChange) || ride.has(RideCause::ModelChange) {
            let after_counts = match standing {
                Standing::Current => true,
                Standing::Older { stamp, .. } => self
                    .surface_counts_stamp
                    .is_none_or(|counted| stamp > counted),
            };
            if after_counts {
                self.surface_counts_stale = true;
            }
        }
        let stated = StatedView::of(standing, ride.applied_view.as_ref());
        self.take_signed_floor();
        // A late ride's own reading was not taken, so it is not named as
        // the last prompt.
        let last_prompt = match standing {
            Standing::Current => format!("{:?}", ride.conditions.last_prompt_tokens),
            Standing::Older { .. } => "late, reading ignored".to_owned(),
        };
        tracing::info!(
            session = %self.key.session,
            causes = ?ride.causes,
            request_tokens = ?ride.request_tokens,
            last_prompt_tokens = %last_prompt,
            applied_view = ?ride.applied_view.as_ref().map(|view| view.version),
            "ck-mc: session: the runner requested a ride"
        );
        self.settle_stated(stated, &[]);
        // A provider refusal still permits reclaim when the last reading is
        // stale: the refused request did not fit under the current view.
        let judged = self.judged_view(stated);
        match standing {
            Standing::Current => self.judge_reading(previous, judged.as_ref()),
            Standing::Older { .. } => self.judge_held_reading(was_stale, judged.as_ref()),
        }
        let over_limit = ride.has(RideCause::OverLimit).then(|| {
            // A stated count of zero says nothing about the request, so it
            // is planned as no count on both paths.
            let count = match ride.request_tokens.filter(|&count| count > 0) {
                Some(count) => lanes::RideCount::Stated(count),
                None => {
                    // The provider refused the request, so it exceeded the
                    // usable window even without a stated count. Where the
                    // fixed part is inferred from the reading, keep any
                    // larger reading.
                    let floor = pass::usable_window(&self.conditions)
                        .max(self.conditions.last_prompt_tokens.unwrap_or(0));
                    tracing::info!(
                        session = %self.key.session,
                        floor_tokens = %floor,
                        "ck-mc: session: over_limit without request_tokens; using a request floor"
                    );
                    lanes::RideCount::Unstated { floor }
                }
            };
            lanes::OverLimit {
                count,
                // The count describes ck-mc's newest view only when the
                // runner applies that very view, checksum included, as
                // settling a view requires.
                newest_view: match (ride.applied_view.as_ref(), self.latest.as_ref()) {
                    (Some(applied), Some(view)) => same(applied, view),
                    (None, None) => true,
                    _ => false,
                },
            }
        });
        // Only a cause that changes the request's bytes before the
        // conversation folds the head for free. A forgotten cache (expiry, a
        // chain reset, a tier or account switch, an unknown cause) adds
        // nothing to any ride, whatever it comes with: `[over_limit,
        // chain_reset]` is `[over_limit]`. Re-rendering `m[0]` there would
        // invalidate every signed thinking block, and the request fits
        // without it.
        let prefix_changes = ride
            .causes
            .iter()
            .any(|cause| pass::ride_cause_kind(cause) == pass::RideCauseKind::PrefixChanges);
        let permitted = if over_limit.is_some() || prefix_changes {
            // A settings change `m[0]` depends on folds in the same rewrite,
            // as on a notice.
            if prefix_changes || self.head_shape_changed(settings) {
                self.fold_due = true;
            }
            true
        } else {
            // Cache-state and soft-budget signals add no permission: the pass
            // rebuilds only if a notice with these conditions would.
            self.rebuild_permitted(settings)
        };
        if !permitted {
            tracing::info!(
                session = %self.key.session,
                causes = ?ride.causes,
                "ck-mc: session: ride adds no rebuild permission; the current view stays"
            );
            return None;
        }
        // A `ctx_keep` waiting for the next notice lands in this rewrite. On a
        // ride that answers nothing it stays waiting for that notice.
        let kept = self.ready_keep(false).cloned();
        let view = self
            .build(settings, over_limit, prefix_changes, kept.as_ref())
            .0?;
        // The size limit holds for a view in a ride's answer as for a pushed
        // one (compaction contract V5); an oversized one is answered as nothing.
        if self.refuse_oversized(&view) {
            return None;
        }
        self.accept(view.clone());
        // The runner takes a ride's view with the answer, so this is where it
        // is accepted; it logs the same line as a pushed view. An answer that
        // never reaches the runner rolls the view back
        // ([`Session::ride_undelivered`]).
        self.runner_holds(view.version);
        self.log_view_accepted(&view, None);
        Some(view)
    }

    /// The first view of a moved session: the history head and a cut through
    /// at most `cut` (ordinal, message id). The caller keeps the newest entry
    /// visible; summary coverage can shorten that cut further, so unsummarized
    /// entries never disappear. The session records the view as current; the
    /// runner's move tool installs it before Setup.
    pub fn first_view_after_move(
        &mut self,
        settings: &Settings,
        cut: Option<(u64, &str)>,
    ) -> Result<View, String> {
        let covered = self.last_summary_ordinal().zip(self.last_summary_end());
        let cut = cut.and_then(|cut| {
            covered.as_ref().map(|(ordinal, mid)| {
                if cut.0 > *ordinal {
                    (*ordinal, mid.as_str())
                } else {
                    cut
                }
            })
        });
        self.fold_due = true;
        let mut ops = self.render_head(settings);
        if self.next_baseline.is_none() || !ops.iter().any(head::is_head) {
            return Err(
                "history_head_unavailable: cannot render the moved session's history head".into(),
            );
        }
        if let Some((_, mid)) = cut {
            ops.push(EditOp::Cut {
                through: mid.to_string(),
            });
        }
        let version = self.version + 1;
        let view = View::seal(
            version,
            ops.into_iter()
                .map(|op| cortexkit_role_compaction::view::Edit::new(version, op))
                .collect(),
        );
        self.app_capture_head(&view);
        if let Some(next) = self.next_baseline.take() {
            self.baseline = Some(next);
            self.fold_due = false;
        }
        self.version = version;
        self.cut = cut.map(|(ordinal, _)| ordinal);
        self.set_move_floor(cut);
        // The move installs this view, and the host may stop loading the
        // messages before its cut, as for a view the runner applied.
        self.marker_possible = true;
        self.index = Index::starting_at(self.cut.unwrap_or(1));
        self.latest = Some(view.clone());
        Ok(view)
    }

    /// A spent emergency batch waits for another rewrite, but an over-limit
    /// request must reclaim even when the pressure episode is already spent.
    pub(super) fn emergency_drop_allowed(
        &self,
        settings: &Settings,
        over_limit: bool,
        priced: bool,
    ) -> bool {
        over_limit
            || (pass::in_force_band(&self.pressure(), settings)
                && (priced || !self.emergency_latched))
    }

    /// Credit only what this pass stops sending: queued drops and, when the
    /// cut moves, the net saving after replacing the old head and cut. Comparing
    /// total served costs counts overlapping removals once and charges the new
    /// head instead of treating summarized text as fixed provider overhead.
    /// A head-only refresh deliberately gets no credit, keeping the history
    /// accounting change confined to passes that move the cut. What the other
    /// lanes remove on the same pass (the age sweep, supersession, reasoning
    /// clearing) is deliberately left out: this credit serves only the plan
    /// that infers the fixed part from the reading, which has always sized
    /// the request as if that work had not landed.
    pub(super) fn emergency_removed_tokens(
        &self,
        history: &[EditOp],
        queued_ops: &[EditOp],
    ) -> u64 {
        let previous = || self.latest.iter().flat_map(|v| &v.edits).map(|e| &e.op);
        let old_cut = previous().find_map(|op| match op {
            EditOp::Cut { through } => Some(through),
            _ => None,
        });
        let new_cut = history.iter().find_map(|op| match op {
            EditOp::Cut { through } => Some(through),
            _ => None,
        });
        // Without a replacement cut, the builder carries the old one until
        // the last summary is retired; missing history ops do not undo it.
        let cut_moves = old_cut != new_cut && (new_cut.is_some() || self.summaries.is_empty());
        if !cut_moves && queued_ops.is_empty() {
            return 0;
        }
        let (before, old_head) = self.served_costs(previous());
        let (after, new_head) = self.served_costs(
            previous()
                .filter(|op| {
                    !cut_moves || (!head::is_head(op) && !matches!(op, EditOp::Cut { .. }))
                })
                .chain(history.iter().filter(|_| cut_moves))
                .chain(queued_ops.iter()),
        );
        if !cut_moves {
            return before
                .iter()
                .map(|(key, old)| old.saturating_sub(after.get(key).copied().unwrap_or(0)))
                .sum();
        }
        (before.values().sum::<u64>() + old_head)
            .saturating_sub(after.values().sum::<u64>() + new_head)
    }

    /// What ck-mc measures about the request this pass will serve, for the
    /// emergency lane. `ops` are the edits of every lane planned before the
    /// emergency lane on this pass. `None` when the fixed part can't be
    /// measured: a surface count is absent or not exact, was taken for
    /// another model, or a ride has reported a change to the surfaces or the
    /// model since. The lane then infers the fixed part from the reading.
    pub(super) fn emergency_measured(
        &self,
        history: &[EditOp],
        ops: &[EditOp],
        over_limit: Option<lanes::OverLimit>,
    ) -> Option<lanes::Measured> {
        if self.surface_counts_stale
            || self.surface_counts_model.as_ref() != Some(&self.conditions.model)
        {
            return None;
        }
        let (Some(system), Some(tools)) = self.surface_tokens else {
            return None;
        };
        if !system.exact || !tools.exact {
            return None;
        }
        let served = self.emergency_served(history, ops);
        let change = served.total - served.previous_total;
        let request = match over_limit {
            None => lanes::MeasuredRequest::Served,
            Some(over) if !over.newest_view => lanes::MeasuredRequest::OlderView,
            Some(lanes::OverLimit {
                count: lanes::RideCount::Stated(count),
                ..
            }) => lanes::MeasuredRequest::Counted { count, change },
            Some(_) => lanes::MeasuredRequest::Refused { change },
        };
        Some(lanes::Measured {
            system_tokens: system.count,
            tools_tokens: tools.count,
            head_tokens: served.head,
            notes_tokens: self
                .notes
                .pending
                .filter(|notes| notes.exact)
                .map(|notes| notes.count),
            transcript_tokens: served.parts.values().sum(),
            parts: served.parts,
            request,
        })
    }

    /// The request the view this pass builds would serve before the
    /// emergency lane adds to it: ck-mc's newest view with this pass's
    /// history head and cut and the edits `ops` of the lanes planned so far.
    /// As the view builder does, it keeps a head message or cut of the
    /// newest view unless this pass replaces it, or the session has no
    /// summaries left and this pass doesn't render it. Each part is priced at
    /// what stays of it, so a placeholder costs what the placeholder does.
    pub(super) fn emergency_served(&self, history: &[EditOp], ops: &[EditOp]) -> EmergencyServed {
        let previous = || self.latest.iter().flat_map(|v| &v.edits).map(|e| &e.op);
        let retire = retired_history(self.summaries.is_empty(), history);
        let renders = |id: &str| {
            history
                .iter()
                .any(|op| matches!(op, EditOp::Insert { message, .. } if message.id == id))
        };
        let new_cut = history.iter().any(|op| matches!(op, EditOp::Cut { .. }));
        let carried = previous().filter(|op| match op {
            EditOp::Insert { message, .. } => !renders(&message.id) && !retire(op),
            EditOp::Cut { .. } => !new_cut && !retire(op),
            _ => true,
        });
        let (before, old_head) = self.served_costs(previous());
        let (parts, head) = self.served_costs(carried.chain(history.iter()).chain(ops.iter()));
        let total = |costs: &std::collections::BTreeMap<lanes::PartKey, u64>, head: u64| {
            (costs.values().sum::<u64>() + head) as i64
        };
        EmergencyServed {
            total: total(&parts, head),
            previous_total: total(&before, old_head),
            parts,
            head,
        }
    }

    /// A pass with permission to rebuild: every lane adds the parts it wants
    /// gone, and one view carries them. `None` when no lane has work.
    ///
    /// A view that fails ck-mc's own checks is a bug in a lane. It is logged
    /// and the work it held is dropped, so the same failure does not repeat
    /// on every pass.
    ///
    /// `over_limit` is set when the runner asked for a view because its next
    /// request was refused for length, and carries the stated count or its
    /// absence, and whether the refused request used ck-mc's newest view.
    /// The emergency drop then runs whatever the usage, and the protections that
    /// can yield do. `prefix_changes` is set on a ride whose request's bytes
    /// before the conversation change anyway, so the cache is lost whether or
    /// not a view follows.
    ///
    /// Also returns roughly how many tokens the new edits free, plus what the
    /// age sweep has lined up for the next pass.
    pub(super) fn build(
        &mut self,
        settings: &Settings,
        over_limit: Option<lanes::OverLimit>,
        prefix_changes: bool,
        keep: Option<&BTreeSet<lanes::PartKey>>,
    ) -> (Option<View>, u64) {
        self.build_for(settings, over_limit, prefix_changes, keep, false)
    }

    pub(super) fn ready_keep(&self, after_notice: bool) -> Option<&BTreeSet<lanes::PartKey>> {
        let kept = self.pending_keep.as_ref()?;
        let call = lanes::keep_call(&self.index)?;
        let ready = self.pending_keep_after.is_none_or(|wait| {
            call.ordinal > wait.call_ordinal
                // If a notice has already added more transcript without the
                // new call, use the last known boundary rather than shield
                // the selection indefinitely. Only notices trigger this fallback.
                || (after_notice && call.ordinal == wait.call_ordinal
                    && self.index.entries().last().is_some_and(|last| last.ordinal > wait.indexed_through))
        });
        (!self.latest_unknown && ready).then_some(kept)
    }

    /// A `ctx_keep` leaves the queue only after a pass with a call boundary
    /// has built a view or found nothing to remove.
    pub(super) fn take_landed_keep(
        &mut self,
    ) -> (Option<BTreeSet<lanes::PartKey>>, Option<KeepWait>) {
        let keep = self.next_keep.take();
        let after = if keep.is_some() && self.pending_keep == keep {
            self.pending_keep = None;
            self.handled_keep_call = lanes::keep_call(&self.index).map(|entry| entry.ordinal);
            self.pending_keep_after.take()
        } else {
            None
        };
        (keep, after)
    }

    pub(super) fn build_for(
        &mut self,
        settings: &Settings,
        over_limit: Option<lanes::OverLimit>,
        prefix_changes: bool,
        keep: Option<&BTreeSet<lanes::PartKey>>,
        flush: bool,
    ) -> (Option<View>, u64) {
        // The recovery is saved before handover. Until the runner holds it,
        // another build must not spend the same immediate attempt again.
        if self.recovery_in_flight() {
            return (None, 0);
        }
        self.next_flush = flush;
        let _timing = crate::notice_cost_timing::span("build.total");
        // Before anything is built on summaries context.db no longer has.
        // When the cut moves back past what the index holds, the transcript
        // is read again first and this build waits for it.
        self.reload_changed_summaries();
        if !self.index_ready {
            return (None, 0);
        }
        if self.latest_unknown {
            tracing::info!(
                session = %self.key.session,
                "ck-mc: session: no view until the runner's applied view is read back"
            );
            return (None, 0);
        }
        // A moved session whose summaries stop short of its move floor can
        // build no view the runner may take: each would cut where the
        // summaries end, before the floor. A `ctx_keep` this pass carried
        // waits for a view that can land it.
        if self.short_of_move_floor() {
            self.hold_below_move_floor("a cut where the summaries end");
            return (None, 0);
        }
        // The same for history the runner serves without part numbers: the
        // summary through it is due, and views wait for it. A session
        // without a summarizer whose view was refused for it waits for the
        // next Setup.
        if self.short_of_numbers_floor() || self.numbers_views_held {
            if !self.numbers_views_held {
                self.hold_below_numbers_floor("a cut where the summaries end");
            }
            return (None, 0);
        }
        self.next_keep = keep.cloned();
        self.retire_banned_queued();
        self.app_cause = if over_limit.is_some() {
            "over_limit"
        } else if prefix_changes {
            "cache_lost"
        } else if self.head_stale {
            "history_changed"
        } else if self.summary_on_its_way()
            || self.summaries.last().is_some_and(|s| {
                self.baseline
                    .as_ref()
                    .is_none_or(|b| s.sequence > b.through_sequence)
            })
        {
            "history_refresh"
        } else {
            "execute"
        }
        .into();
        let (mut history, cut) = self.history_ops(settings, flush);
        let latched = self.emergency_latched;
        let (sealed, freed) = self.build_lanes(settings, over_limit, prefix_changes, &history, cut);
        match sealed {
            Sealed::Done(view) => (view, freed),
            Sealed::RetryWithoutCut => {
                // A cut affects lane eligibility and how much the emergency
                // lane still needs to free. Re-plan before sealing again.
                self.emergency_latched = latched;
                history.retain(|op| !matches!(op, EditOp::Cut { .. }));
                if let Some(previous) = self
                    .latest
                    .iter()
                    .flat_map(|view| &view.edits)
                    .find(|edit| matches!(edit.op, EditOp::Cut { .. }))
                {
                    history.push(previous.op.clone());
                }
                let (sealed, freed) =
                    self.build_lanes(settings, over_limit, prefix_changes, &history, None);
                let Sealed::Done(view) = sealed else {
                    unreachable!("the retry proposes no new cut")
                };
                (view, freed)
            }
        }
    }

    fn build_lanes(
        &mut self,
        settings: &Settings,
        over_limit: Option<lanes::OverLimit>,
        prefix_changes: bool,
        history: &[EditOp],
        cut: Option<u64>,
    ) -> (Sealed, u64) {
        let keep = self.next_keep.as_ref().or(self.pending_keep.as_ref());
        let flush = self.next_flush;
        let lanes_timing = crate::notice_cost_timing::span("build.lanes");
        let edited = self.edited(cut);
        let (context, usable, cutoff) = Self::lane_context(
            &self.index,
            &edited,
            settings,
            &self.conditions,
            self.features.keep_first_message,
            self.signed_floor(),
        );
        // A part two lanes want keeps the first lane's shape, so the order
        // here decides it: the model's own request first, then the lanes
        // that keep a call, then the rest. A requested part in the protected
        // tail waits until it leaves the tail, as in the plugin
        // (`pendingDropVeto`).
        let mut wanted: Vec<(lanes::PartKey, lanes::Shape)> = self
            .queued
            .iter()
            .filter(|key| !lanes::in_protected_tail(&context, key, cutoff))
            .map(|key| (key.clone(), lanes::Shape::Requested))
            .collect();
        if let Some(kept) = self.next_keep.as_ref() {
            wanted.extend(lanes::keep_drops_with_notice_marks(
                &context,
                kept,
                cutoff,
                self.notice_keep,
            ));
        }
        let injected = lanes::injected_text(&context, cutoff);
        // Parts whose only edit is a stripped injection: caveman may compress
        // them on this pass, starting from the stripped text.
        let stripped_only: Vec<lanes::PartKey> = injected
            .iter()
            .map(|(key, _)| key.clone())
            .filter(|key| !wanted.iter().any(|(earlier, _)| earlier == key))
            .collect();
        wanted.extend(injected);
        // These tool-reclaim lanes (superseded edits, spent control-plane
        // calls, and the tool part of the age sweep below) run in the force
        // band too. The emergency lane can't always reclaim there (a fixed
        // part above the ceiling, a spent episode), and these lanes are then
        // all that keeps the request shrinking. Whether they should stand
        // down in the band, as the TypeScript transform's tool-reclaim
        // admission does, is an open design question.
        wanted.extend(lanes::superseded_edits(
            &context,
            cutoff,
            self.reclaim_bookmark,
        ));
        wanted.extend(lanes::spent_control_plane(&context, cutoff));
        wanted.extend(lanes::duplicate_lookups(&context, cutoff));
        // An unmarked notice may carry the person's words. Without notice_keep,
        // sweeping notices could drop them, so neither select nor bookmark them.
        let notice_reclaim_bookmark = if self.notice_keep {
            self.notice_reclaim_bookmark
        } else {
            0
        };
        wanted.extend(lanes::age_sweep(
            &context,
            self.reclaim_bookmark,
            notice_reclaim_bookmark,
            cutoff,
        ));
        let model = &self.conditions.model;
        let anthropic = model.provider.contains("anthropic") || model.model.contains("claude");
        wanted.extend(lanes::reasoning_over_budget(
            &context,
            settings.keep_reasoning_tokens,
            anthropic,
        ));
        wanted.retain(|(key, shape)| {
            *shape == lanes::Shape::Requested || !self.failed_parts.contains(key)
        });
        // On a `ctx_keep` pass the parts the model chose stay whole: the
        // other lanes still land, but none of them takes a kept part.
        let kept = |key: &lanes::PartKey| keep.is_some_and(|kept| kept.contains(key));
        wanted.retain(|(key, _)| !kept(key));
        let (mut ops, mut covered) = lanes::drop_ops(&context, &wanted);
        // Another rewrite on this pass: a lane edit, a history head or cut
        // that changes, or a ride whose request's prefix changes anyway.
        let head_changes = history.iter().any(|op| {
            !self
                .latest
                .as_ref()
                .is_some_and(|view| view.edits.iter().any(|edit| edit.op == *op))
        });
        let priced = !ops.is_empty() || head_changes || prefix_changes;
        self.next_latch = false;
        if self.emergency_drop_allowed(settings, over_limit.is_some(), priced) {
            let queued_for_emergency: Vec<_> = wanted
                .iter()
                .filter(|(_, shape)| *shape == lanes::Shape::Requested)
                .cloned()
                .collect();
            let (queued_ops, queued_covered) = lanes::drop_ops(&context, &queued_for_emergency);
            let removed_tokens = self.emergency_removed_tokens(history, &queued_ops);
            let emergency = lanes::Emergency {
                prompt_tokens: self.pressure().last_prompt_tokens.unwrap_or(0),
                request_tokens: over_limit.map(lanes::OverLimit::request_tokens),
                notes: self.notes.clone(),
                ceiling_tokens: (usable as f64 * settings.execute_threshold_percentage / 100.0)
                    as u64,
                usable_tokens: usable,
                over_limit: over_limit.is_some(),
                priced,
                removed_tokens,
                measured: self.emergency_measured(history, &ops, over_limit),
            };
            // Measured, the request is already priced after every lane
            // planned so far, so on a force pass none of their parts is a
            // candidate again. A refused request may still take such a part
            // whole, for what that lane leaves of it. The inferred plan, as
            // before, leaves out only the queued drops.
            let emergency_edited = if emergency.measured.is_some() && over_limit.is_none() {
                edited.including(&covered)
            } else {
                edited.including(&queued_covered)
            };
            let emergency_context = lanes::Context {
                edited: &emergency_edited,
                ..context
            };
            let (selected, plan) = lanes::emergency_drop_planned(
                &emergency_context,
                cutoff,
                &emergency,
                self.counter(),
                |entry, part| {
                    if self.failed_parts.is_empty() && keep.is_none() {
                        return false;
                    }
                    let key = (entry.mid.clone(), part.id.clone());
                    self.failed_parts.contains(&key) || kept(&key)
                },
            );
            if let Some(plan) = plan {
                // `selected` counts the parts the plan chose, not edits the
                // runner applies: a chosen part another lane already removes
                // on this pass adds no edit of its own.
                tracing::info!(
                    session = %self.key.session,
                    fixed_tokens = plan.fixed_tokens,
                    fixed_from = %plan.fixed_from,
                    size_tokens = plan.size_tokens,
                    size_from = %plan.size_from,
                    ceiling_tokens = plan.ceiling_tokens,
                    target_tokens = %plan
                        .target_tokens
                        .map_or_else(|| "none".to_owned(), |target| target.to_string()),
                    stop = %plan.stop,
                    selected = selected.len(),
                    "ck-mc: session: emergency drop planned"
                );
            }
            if !selected.is_empty() {
                // An over-limit request drops calls whole, whatever shape an
                // earlier lane asked for.
                if over_limit.is_some() {
                    let whole: BTreeSet<&lanes::PartKey> =
                        selected.iter().map(|(key, _)| key).collect();
                    wanted.retain(|(key, _)| !whole.contains(key));
                }
                wanted.extend(selected);
                (ops, covered) = lanes::drop_ops(&context, &wanted);
                // The batch counts once the runner takes the view.
                self.next_latch = true;
            }
        }
        // A rewrite with no batch rearms the emergency lane, so outputs that
        // become droppable later can still form one (the plugin keeps the
        // episode armed on such a pass). A changed prefix loses the cache
        // whether or not a view follows; a lane edit or head change counts
        // once taken.
        self.next_rearm = false;
        if priced && !self.next_latch {
            if prefix_changes {
                self.emergency_latched = false;
            } else {
                self.next_rearm = true;
            }
        }
        // Answered images go once content at least as new has been dropped,
        // by an earlier view or by this pass.
        // Parts set aside after a view failed ck-mc's own checks stay out of
        // every automatic lane, so the failure doesn't repeat each pass.
        let image_skip: Vec<lanes::PartKey> = covered
            .iter()
            .chain(keep.into_iter().flatten())
            .chain(self.failed_parts.iter())
            .cloned()
            .collect();
        let images = lanes::Images {
            outputs: &self.image_outputs,
            watermark: edited
                .watermark(&self.index)
                .max(lanes::ops_watermark(&self.index, &ops)),
            cutoff,
            over_limit: over_limit.is_some(),
            skip: &image_skip,
        };
        let (image_ops, image_parts) = lanes::answered_images(&context, &images);
        let caveman_skip: Vec<lanes::PartKey> = covered
            .iter()
            .filter(|key| !stripped_only.contains(key))
            .cloned()
            .chain(keep.into_iter().flatten().cloned())
            .chain(self.failed_parts.iter().cloned())
            .collect();
        ops.extend(image_ops);
        covered.extend(image_parts);
        // Caveman text replaces any other text edit of the same part this
        // pass made (a stripped injection): it starts from the stripped text.
        self.next_caveman = None;
        if let (true, Some(caveman)) = (self.features.caveman, settings.caveman.as_ref()) {
            let (texts, next) =
                lanes::caveman(&context, caveman, &self.caveman, cutoff, &caveman_skip);
            for ((mid, part_id), text) in texts {
                let Some((_, part)) = self.index.find(&mid, &part_id) else {
                    continue;
                };
                ops.retain(|op| {
                    !matches!(op, EditOp::Replace { mid: m, part: p, field, .. }
                        if *m == mid && *p == part_id && field == "text")
                });
                ops.push(EditOp::Replace {
                    mid,
                    part: part_id,
                    field: "text".into(),
                    value: serde_json::json!(text),
                    expect: part.digest.clone(),
                });
            }
            self.next_caveman = Some(next);
        }
        let bookmark = lanes::far_behind_bookmark(&context, usable);
        let notice_bookmark = if self.notice_keep {
            lanes::notice_far_behind_bookmark(&context, usable)
        } else {
            0
        };
        // The age sweep only drops on the pass after the one that sees an
        // output far behind, so the first pass over the threshold frees
        // little by design. What it has lined up for the next pass counts as
        // relief too, or every session would be asked for ctx_keep on its
        // first crossing.
        let lined_up: Vec<_> = lanes::age_sweep(
            &context,
            bookmark.max(self.reclaim_bookmark),
            notice_bookmark.max(notice_reclaim_bookmark),
            cutoff,
        )
        .into_iter()
        .filter(|(key, _)| !covered.contains(key))
        .collect();
        let (lined_up_ops, lined_up_covered) = lanes::drop_ops(&context, &lined_up);
        let renderable_covered = self.renderable_covered(&ops, &covered);
        let renderable_lined_up = self.renderable_covered(&lined_up_ops, &lined_up_covered);
        let freed = freed_tokens(&context, &renderable_covered)
            + freed_tokens(&context, &renderable_lined_up);
        self.next_reclaim_bookmark = Some(self.reclaim_bookmark.max(bookmark));
        self.next_notice_reclaim_bookmark = self
            .notice_keep
            .then_some(self.notice_reclaim_bookmark.max(notice_bookmark));
        // The existing lanes have first pick, and a result they remove on
        // this pass cannot stand in for an older call.
        let ride_edited = edited.including(&renderable_covered);
        let ride_context = lanes::Context {
            edited: &ride_edited,
            ..context
        };
        let mut ride_wanted = lanes::superseded_reads(&ride_context, cutoff);
        ride_wanted.extend(lanes::retried_failures(&ride_context, cutoff));
        ride_wanted.retain(|(key, _)| !kept(key) && !self.failed_parts.contains(key));
        let ride_parts: Vec<_> = if ride_wanted.is_empty() {
            Vec::new()
        } else {
            lanes::drop_ops(&ride_context, &ride_wanted)
                .0
                .into_iter()
                .filter_map(|op| {
                    if self.render_failed.excludes(&op) {
                        return None;
                    }
                    match op {
                        EditOp::Drop {
                            mid,
                            part: Some(part),
                        } => Some((mid, part)),
                        _ => None,
                    }
                })
                .collect()
        };
        // A pass whose lanes have no new edit publishes nothing. A memory
        // another writer saved changes only the history head's second
        // message: it waits for a pass that rewrites anyway, as the plugin's
        // history refresh rides a rewrite and never starts one.
        let shown;
        let history = if !flush
            && ops.is_empty()
            && !prefix_changes
            && over_limit.is_none()
            && self.next_keep.is_none()
            && !self.summary_unshown
            && !self.head_stale
            && self.only_m1_changes(history)
        {
            shown = self.head_as_shown(
                "only memories in m[1] changed; they wait for a pass that rewrites anyway",
            );
            &shown
        } else {
            history
        };
        ops.extend(history.iter().cloned());
        drop(lanes_timing);
        let riders = view_builder::RideDrops {
            parts: &ride_parts,
            prefix_changes,
        };
        let sealed = self.seal_candidate(ops, &covered, true, false, riders);
        let ride_freed = if matches!(sealed, Sealed::Done(Some(_))) {
            ride_parts
                .iter()
                .filter(|key| self.next_covered.contains(key) && !renderable_lined_up.contains(key))
                .filter_map(|(mid, part)| self.index.find(mid, part))
                .map(|(_, part)| crate::tokens::part(part))
                .sum()
        } else {
            0
        };
        (sealed, freed + ride_freed)
    }

    /// Commands and rebuilds use the same tail boundary, so queued work is
    /// reported as ready only after it leaves the recent protected tail.
    pub(super) fn lane_context<'a>(
        index: &'a Index,
        edited: &'a lanes::Edited,
        settings: &'a Settings,
        conditions: &Conditions,
        keep_first_message: bool,
        signed_floor: Option<u64>,
    ) -> (lanes::Context<'a>, u64, Option<u64>) {
        let context = lanes::Context {
            index,
            edited,
            protected_tools: &settings.protected_tools,
            keep_first_message,
            signed_floor,
        };
        let usable = pass::usable_window(conditions);
        let floor = settings
            .protected_tokens
            .unwrap_or_else(|| lanes::default_protected_tokens(usable));
        let cutoff = lanes::protected_cutoff(&context, floor);
        (context, usable, cutoff)
    }

    /// Turn a pass's edits into the next view, and forget the queued drops
    /// it covers.
    #[cfg(test)]
    pub(super) fn seal(&mut self, ops: Vec<EditOp>, covered: &[lanes::PartKey]) -> Option<View> {
        let remaining = ops
            .iter()
            .filter(|op| !matches!(op, EditOp::Cut { .. }))
            .cloned()
            .collect();
        let riders = view_builder::RideDrops::default();
        match self.seal_candidate(ops, covered, true, false, riders) {
            Sealed::Done(view) => view,
            Sealed::RetryWithoutCut => {
                let Sealed::Done(view) =
                    self.seal_candidate(remaining, covered, false, true, riders)
                else {
                    unreachable!("the retry proposes no new cut")
                };
                view
            }
        }
    }

    fn seal_candidate(
        &mut self,
        mut ops: Vec<EditOp>,
        covered: &[lanes::PartKey],
        retry_cut: bool,
        keep_old_cut: bool,
        riders: view_builder::RideDrops<'_>,
    ) -> Sealed {
        if self.recovery_in_flight() {
            return Sealed::Done(None);
        }
        let _timing = crate::notice_cost_timing::span("build.seal");
        let version = self.version + 1;
        ops.retain(|op| !self.render_failed.excludes(op));
        let mut covered = self.renderable_covered(&ops, covered);
        let is_cut = |op: &EditOp| matches!(op, EditOp::Cut { .. });
        let has_new_cut = retry_cut
            && ops.iter().any(|op| {
                is_cut(op)
                    && !self
                        .latest
                        .iter()
                        .flat_map(|view| &view.edits)
                        .any(|e| e.op == *op)
            });
        let built = {
            let retire = retired_history(self.summaries.is_empty(), &ops);
            let full = self.with_replaced_outputs(&ops);
            view_builder::next_view_with_riders(
                self.latest.as_ref(),
                full.as_deref().unwrap_or(self.index.entries()),
                ops,
                view_builder::ViewPolicy {
                    rules: &self.conditions.rules,
                    version,
                    built_through: self
                        .index
                        .cursor()
                        .filter(|_| self.view_anchor)
                        .map(|cursor| cursor.mid.clone()),
                    new_signed: (self.view_anchor
                        && cortexkit_compaction_view::rules::is_bound_signed_model(
                            &self.conditions.model.model,
                        ))
                    .then(|| "strip".into()),
                    signed_floor: self.signed_floor.clone(),
                    force: self.render_failed.repair_pending,
                },
                |op| {
                    (!(keep_old_cut && is_cut(op)) && retire(op)) || self.render_failed.excludes(op)
                },
                &mut self.view_validation,
                riders,
            )
        };
        Sealed::Done(match built {
            Ok(Some(view)) => {
                if self.repeats_failed_edits(&view) {
                    self.discard_held_view();
                    return Sealed::Done(None);
                }
                // Provider-rule companion drops of signed reasoning remain
                // allowed on an excluded message: without them, edits before
                // that reasoning would produce a request the provider refuses.
                if self.repeats_failed_reasoning_drop(&view) {
                    self.discard_held_view();
                    return Sealed::Done(None);
                }
                // A moved session's view must cut at or after its move floor
                // (see `move_floor`). One that doesn't stays here, and the
                // runner keeps serving the view it has.
                if let Some(why) = self.move_floor_breach(&view) {
                    self.discard_held_view();
                    self.hold_below_move_floor(&why);
                    return Sealed::Done(None);
                }
                self.release_move_floor_hold();
                // Nor may any view cut before history the runner serves
                // without part numbers (see `numbers_unknown`).
                if let Some(why) = self.numbers_floor_breach(&view) {
                    self.discard_held_view();
                    self.log_running_call_below_numbers_floor();
                    self.hold_below_numbers_floor(&why);
                    return Sealed::Done(None);
                }
                self.release_numbers_floor_hold();
                self.version = version;
                covered.extend(riders.parts.iter().filter(|(mid, part)| {
                    view.edits.iter().any(|edit| {
                        edit.since == version && matches!(&edit.op, EditOp::Drop { mid: m, part: Some(p) } if m == mid && p == part)
                    })
                }).cloned());
                self.next_covered = covered;
                Some(view)
            }
            // Nothing new to land: what the pass covered was covered already.
            // The head it rendered is the one shown, so a due fold is done:
            // left pending, it would rewrite `m[0]` on a later pass whose
            // cache is still warm.
            Ok(None) => {
                self.take_landed_keep();
                self.commit_bookmark();
                let flush = std::mem::take(&mut self.next_flush);
                self.forget_queued(&covered);
                if let Some(next) = self.next_baseline.take() {
                    self.baseline = Some(next);
                    if !flush {
                        self.fold_due = false;
                        self.head_stale = false;
                    }
                }
                if let Some(next) = self.next_caveman.take() {
                    self.caveman = next;
                }
                None
            }
            // A lane's bug. Its work is forgotten, queued drops and the parts
            // automatic lanes chose alike, so the same failure does not repeat
            // on every pass.
            Err(_) if has_new_cut => return Sealed::RetryWithoutCut,
            Err(refusal) => {
                self.commit_bookmark();
                self.forget_queued(&covered);
                self.failed_parts.extend(covered.iter().cloned());
                self.failed_parts.extend(riders.parts.iter().cloned());
                self.next_latch = false;
                self.next_rearm = false;
                tracing::warn!(
                    session = %self.key.session,
                    ?refusal,
                    "ck-mc: session: no valid view"
                );
                None
            }
        })
    }

    /// Tests only: the next view with `ops` added, without ck-mc's checks.
    /// For fixtures that need a view's effect on what ck-mc records, not its
    /// validity: the pinned app-read samples show a dropped part in the
    /// newest message, which [`Session::seal`] now refuses, and their bytes
    /// must not change.
    #[cfg(test)]
    pub(crate) fn seal_unchecked(&mut self, ops: Vec<EditOp>) -> View {
        let version = self.version + 1;
        self.version = version;
        let mut edits = self
            .latest
            .as_ref()
            .map(|view| view.edits.clone())
            .unwrap_or_default();
        edits.extend(
            ops.into_iter()
                .map(|op| cortexkit_role_compaction::view::Edit::new(version, op)),
        );
        View::seal(version, edits)
    }

    /// Whether `view` is over the size limit (compaction contract V5). Views name edits, never
    /// copies, so one this large is a bug in the code that built it. It is
    /// not sent, the runner keeps the view it has, and the queued drops it
    /// carried are forgotten, as for any view that fails ck-mc's own checks.
    pub(super) fn refuse_oversized(&mut self, view: &View) -> bool {
        let _timing = crate::notice_cost_timing::span("publish.size_check");
        let size = self.view_validation.encoded_size(view);
        if size <= MAX_VIEW_BYTES {
            return false;
        }
        self.next_baseline = None;
        self.next_caveman = None;
        self.next_latch = false;
        self.next_rearm = false;
        let covered = std::mem::take(&mut self.next_covered);
        self.forget_queued(&covered);
        // As after a view that fails ck-mc's own checks: its parts are set
        // aside, so the same oversized view isn't built again on every pass.
        self.failed_parts.extend(covered.iter().cloned());
        tracing::info!(
            session = %self.key.session,
            view_version = %view.version,
            bytes = %size,
            max_bytes = %MAX_VIEW_BYTES,
            "ck-mc: session: view not sent: view_too_large"
        );
        true
    }

    /// The cache-bust analyzer reads the view version, edit count and cut
    /// to tell which request first carried a rebuilt view. The cut field
    /// distinguishes `cut through <message id>` from `no cut`.
    pub(super) fn log_view_accepted(&self, view: &View, note: Option<&str>) {
        let cut = view
            .edits
            .iter()
            .find_map(|edit| match &edit.op {
                EditOp::Cut { through } => Some(format!("cut through {through}")),
                _ => None,
            })
            .unwrap_or_else(|| "no cut".to_string());
        let note = note.map(|note| format!("; {note}")).unwrap_or_default();
        tracing::info!(
            session = %self.key.session,
            view_version = %view.version,
            edit_count = %view.edits.len(),
            %cut,
            %note,
            "ck-mc: session: view accepted"
        );
    }
}
