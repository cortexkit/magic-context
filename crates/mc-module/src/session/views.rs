//! Rides, and building and sealing the views a pass produces.

use super::*;

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
        let stated = StatedView::of(standing, ride.applied_view.as_ref());
        self.take_signed_floor();
        // A late ride's own reading was not taken, so it is not named as
        // the last prompt.
        let last_prompt = match standing {
            Standing::Current => format!("{:?}", ride.conditions.last_prompt_tokens),
            Standing::Older { .. } => "late, reading ignored".to_owned(),
        };
        tracing::info!(
            "ck-mc: session {}: ride {:?}, request {:?} tokens, last prompt {last_prompt}, applied view {:?}",
            self.key.session,
            ride.causes,
            ride.request_tokens,
            ride.applied_view.as_ref().map(|view| view.version),
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
            ride.request_tokens.unwrap_or_else(|| {
                // The provider refused the request, so it exceeded the usable
                // window even without a stated count. Keep any larger reading.
                let floor = pass::usable_window(&self.conditions)
                    .max(self.conditions.last_prompt_tokens.unwrap_or(0));
                tracing::info!(
                    "ck-mc: session {}: over_limit without request_tokens: using a request floor of {floor} tokens",
                    self.key.session
                );
                floor
            })
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
                "ck-mc: session {}: ride {:?} adds no rebuild permission; the current view stays",
                self.key.session,
                ride.causes,
            );
            return None;
        }
        // A `ctx_keep` waiting for the next notice lands in this rewrite. On a
        // ride that answers nothing it stays waiting for that notice.
        let kept = self.pending_keep.take_if(|_| !self.latest_unknown);
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
    /// accounting change confined to passes that move the cut. Routine cleanup
    /// is excluded because the emergency selector plans before it.
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

    /// A pass with permission to rebuild: every lane adds the parts it wants
    /// gone, and one view carries them. `None` when no lane has work.
    ///
    /// A view that fails ck-mc's own checks is a bug in a lane. It is logged
    /// and the work it held is dropped, so the same failure does not repeat
    /// on every pass.
    ///
    /// `over_limit` is set when the runner asked for a view because its next
    /// request was refused for length, and carries the provider's stated count
    /// or a lower bound from the usable window and last reading. The
    /// emergency drop then runs whatever the usage, and the protections that
    /// can yield do. `prefix_changes` is set on a ride whose request's bytes
    /// before the conversation change anyway, so the cache is lost whether or
    /// not a view follows.
    ///
    /// Also returns roughly how many tokens the new edits free, plus what the
    /// age sweep has lined up for the next pass.
    pub(super) fn build(
        &mut self,
        settings: &Settings,
        over_limit: Option<u64>,
        prefix_changes: bool,
        keep: Option<&BTreeSet<lanes::PartKey>>,
    ) -> (Option<View>, u64) {
        self.build_for(settings, over_limit, prefix_changes, keep, false)
    }

    pub(super) fn build_for(
        &mut self,
        settings: &Settings,
        over_limit: Option<u64>,
        prefix_changes: bool,
        keep: Option<&BTreeSet<lanes::PartKey>>,
        flush: bool,
    ) -> (Option<View>, u64) {
        // The recovery is saved before handover. Until the runner holds it,
        // another build must not spend the same immediate attempt again.
        if self.recovery_in_flight() {
            if let Some(kept) = keep {
                self.pending_keep = Some(kept.clone());
            }
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
                "ck-mc: session {}: no view until the runner's applied view is read back",
                self.key.session
            );
            return (None, 0);
        }
        // A moved session whose summaries stop short of its move floor can
        // build no view the runner may take: each would cut where the
        // summaries end, before the floor. A `ctx_keep` this pass carried
        // waits for a view that can land it.
        if self.short_of_move_floor() {
            if let Some(kept) = keep {
                self.pending_keep = Some(kept.clone());
            }
            self.hold_below_move_floor("a cut where the summaries end");
            return (None, 0);
        }
        // The same for history the runner serves without part numbers: the
        // summary through it is due, and views wait for it. A session
        // without a summarizer whose view was refused for it waits for the
        // next Setup.
        if self.short_of_numbers_floor() || self.numbers_views_held {
            if let Some(kept) = keep {
                self.pending_keep = Some(kept.clone());
            }
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
        let (history, cut) = self.history_ops(settings, flush);
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
        if let Some(kept) = keep {
            wanted.extend(lanes::keep_drops(&context, kept, cutoff));
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
        wanted.retain(|(key, _)| !self.failed_parts.contains(key));
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
            let removed_tokens = self.emergency_removed_tokens(&history, &queued_ops);
            let emergency = lanes::Emergency {
                prompt_tokens: self.pressure().last_prompt_tokens.unwrap_or(0),
                request_tokens: over_limit,
                notes: self.notes.clone(),
                ceiling_tokens: (usable as f64 * settings.execute_threshold_percentage / 100.0)
                    as u64,
                usable_tokens: usable,
                over_limit: over_limit.is_some(),
                priced,
                removed_tokens,
            };
            let emergency_edited = edited.including(&queued_covered);
            let emergency_context = lanes::Context {
                edited: &emergency_edited,
                ..context
            };
            let mut selected = lanes::emergency_drop(&emergency_context, cutoff, &emergency);
            selected.retain(|(key, _)| !kept(key));
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
        // A pass whose lanes have no new edit publishes nothing. A memory
        // another writer saved changes only the history head's second
        // message: it waits for a pass that rewrites anyway, as the plugin's
        // history refresh rides a rewrite and never starts one.
        let history = if !flush
            && ops.is_empty()
            && !prefix_changes
            && over_limit.is_none()
            && keep.is_none()
            && !self.summary_unshown
            && !self.head_stale
            && self.only_m1_changes(&history)
        {
            self.head_as_shown(
                "only memories in m[1] changed; they wait for a pass that rewrites anyway",
            )
        } else {
            history
        };
        ops.extend(history);
        drop(lanes_timing);
        (self.seal(ops, &covered), freed)
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
    pub(super) fn seal(
        &mut self,
        mut ops: Vec<EditOp>,
        covered: &[lanes::PartKey],
    ) -> Option<View> {
        if self.recovery_in_flight() {
            return None;
        }
        let _timing = crate::notice_cost_timing::span("build.seal");
        let version = self.version + 1;
        ops.retain(|op| !self.render_failed.excludes(op));
        let covered = self.renderable_covered(&ops, covered);
        let retire = retired_history(self.summaries.is_empty(), &ops);
        let full = self.with_replaced_outputs(&ops);
        let built = view_builder::next_view_cached(
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
            |op| retire(op) || self.render_failed.excludes(op),
            &mut self.view_validation,
        );
        match built {
            Ok(Some(view)) => {
                if self.repeats_failed_edits(&view) {
                    self.discard_held_view();
                    return None;
                }
                // Provider-rule companion drops of signed reasoning remain
                // allowed on an excluded message: without them, edits before
                // that reasoning would produce a request the provider refuses.
                if self.repeats_failed_reasoning_drop(&view) {
                    self.discard_held_view();
                    return None;
                }
                // A moved session's view must cut at or after its move floor
                // (see `move_floor`). One that doesn't stays here, and the
                // runner keeps serving the view it has.
                if let Some(why) = self.move_floor_breach(&view) {
                    self.discard_held_view();
                    self.hold_below_move_floor(&why);
                    return None;
                }
                self.release_move_floor_hold();
                // Nor may any view cut before history the runner serves
                // without part numbers (see `numbers_unknown`).
                if let Some(why) = self.numbers_floor_breach(&view) {
                    self.discard_held_view();
                    self.log_running_call_below_numbers_floor();
                    self.hold_below_numbers_floor(&why);
                    return None;
                }
                self.release_numbers_floor_hold();
                self.version = version;
                self.next_covered = covered;
                Some(view)
            }
            // Nothing new to land: what the pass covered was covered already.
            // The head it rendered is the one shown, so a due fold is done:
            // left pending, it would rewrite `m[0]` on a later pass whose
            // cache is still warm.
            Ok(None) => {
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
            Err(refusal) => {
                self.commit_bookmark();
                self.forget_queued(&covered);
                self.failed_parts.extend(covered.iter().cloned());
                self.next_latch = false;
                self.next_rearm = false;
                tracing::warn!(
                    "ck-mc: session {}: no valid view: {refusal:?}",
                    self.key.session
                );
                None
            }
        }
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
            "ck-mc: session {}: view {} not sent: view_too_large ({size} bytes, limit {MAX_VIEW_BYTES})",
            self.key.session, view.version
        );
        true
    }

    /// The cache-bust analyzer parses this line to tell which request first
    /// carried a rebuilt view and how far its cut reached, so keep its shape:
    /// `cut through <message id>` or `no cut`. A `note`, when given, follows
    /// the closing parenthesis after `; `, so the line still starts the same.
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
            "ck-mc: session {}: view {} accepted ({} edits, {cut}){note}",
            self.key.session,
            view.version,
            view.edits.len()
        );
    }
}
