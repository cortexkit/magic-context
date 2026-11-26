//! History the runner serves without part numbers (compaction contract T9
//! to T11, `compaction-numbers-unknown/v1`).
//!
//! When a runner can't establish how an older stretch of the transcript was
//! numbered, it serves that stretch's entries marked `numbers_unknown`, with
//! no `tag` on the parts that would carry one. Three rules follow for
//! ck-mc:
//!
//! - Those numbers can't be named. A `session.entries` read by tag that
//!   names one is refused `numbers_unknown`, for the rest of the session, so
//!   `ctx_reduce` and `ctx_expand` answer such a number with an error and
//!   never ask the runner for it again.
//! - No view may show those entries raw: the runner refuses a view whose cut
//!   is before the last of them (`cut_before_numbers`). On a session with a
//!   summarizer, that entry is a floor every view must cut through, as the
//!   move floor is for a moved session. While the summaries stop short of
//!   it, no view is published, and a summary through it is due at once.
//! - The entries themselves are unchanged apart from their tags; the index
//!   keeps them as the same messages (see `Index::extend`).
//!
//! A session without a summarizer (`worker`, `reader`) has no summaries to
//! cut through, so none of the view rules apply to it here.

use super::move_floor::{breach, cut_of};
use super::*;

impl Session {
    /// The newest entry the runner serves without part numbers that ck-mc
    /// knows of: from the index, or from a `cut_before_numbers` refusal
    /// naming an entry the index holds unmarked. `None` for a session
    /// without a summarizer.
    pub(super) fn numbers_floor(&self) -> Option<MoveFloor> {
        if !self.features.summarizer {
            return None;
        }
        let marked = self.index.numbers_unknown_through().map(|entry| MoveFloor {
            ordinal: entry.ordinal,
            mid: entry.mid.clone(),
        });
        // A refusal's entry counts while it is still where the refusal
        // placed it; a revert that removed it takes the floor away with it.
        let refused = self
            .numbers_refused
            .as_ref()
            .filter(|floor| self.index.ordinal_of(&floor.mid) == Some(floor.ordinal))
            .cloned();
        marked
            .into_iter()
            .chain(refused)
            .max_by_key(|floor| floor.ordinal)
    }

    /// The last entry the summaries, or entries that render nothing a
    /// summary would keep, take out of the raw history: the furthest a cut
    /// may go.
    pub(super) fn numbers_reach(&self) -> Option<u64> {
        let covered = self
            .numbers_covered
            .as_ref()
            .filter(|covered| {
                covered.ordinal < self.index.base()
                    || self.index.ordinal_of(&covered.mid) == Some(covered.ordinal)
            })
            .map(|covered| covered.ordinal);
        self.summarized_through().max(covered)
    }

    /// Whether the summaries stop short of the numbers floor, so that no
    /// view can cut through it yet.
    pub(super) fn short_of_numbers_floor(&self) -> bool {
        self.numbers_floor().is_some_and(|floor| {
            self.numbers_reach()
                .is_none_or(|reach| reach < floor.ordinal)
        })
    }

    /// Why `view` may not go to the runner because it cuts before the
    /// numbers floor, or has no cut; `None` when it may.
    pub(super) fn numbers_floor_breach(&self, view: &View) -> Option<String> {
        let floor = self.numbers_floor()?;
        breach(
            &floor,
            cut_of(view).map(|through| (through, self.index.ordinal_of(through))),
        )
    }

    /// Whether a view must be built now because the summaries reached the
    /// numbers floor while the view ck-mc holds still cuts before it. The
    /// runner refuses that older view at its next step, so the session
    /// would otherwise go unmanaged until a rebuild came for another reason.
    pub(super) fn numbers_view_due(&self) -> bool {
        self.numbers_floor().is_some_and(|floor| {
            // A numbers-only cut is not a summary boundary and so does not
            // advance `self.cut`. Compare the view the runner has instead.
            let served = self
                .unconfirmed
                .iter()
                .rev()
                .find(|pending| pending.accepted)
                .map(|pending| &pending.view)
                .or_else(|| self.applied_copy())
                .and_then(|view| self.rendered_view(Some(view)))
                .and_then(|view| cut_of(&view).and_then(|mid| self.index.ordinal_of(mid)));
            served.is_none_or(|cut| cut < floor.ordinal)
                && self
                    .numbers_reach()
                    .is_some_and(|reach| reach >= floor.ordinal)
        })
    }

    /// Whether the session's summaries reach the history the runner serves
    /// without part numbers, so a tool error may send the model to them.
    pub(super) fn summaries_cover_numbers(&self) -> bool {
        if !self.features.summarizer {
            return false;
        }
        match self.numbers_floor() {
            Some(floor) => self
                .summarized_through()
                .is_some_and(|reach| reach >= floor.ordinal),
            None => !self.summaries.is_empty(),
        }
    }

    /// A view can't cut through the numbers floor because a tool call at
    /// or before it is still running: say which call, once per call, since
    /// views stay held until the runner finishes or fails it.
    pub(super) fn log_running_call_below_numbers_floor(&mut self) {
        let Some((ordinal, name, call_id)) = self.running_call_below_numbers_floor() else {
            return;
        };
        if self.numbers_running_logged.as_deref() == Some(call_id.as_str()) {
            return;
        }
        tracing::warn!(
            session = %self.key.session,
            %ordinal,
            tool = %name,
            %call_id,
            "ck-mc: session: no cut can pass the history without part numbers while a tool call is still running; views wait until the runner finishes or fails it"
        );
        self.numbers_running_logged = Some(call_id);
    }

    /// A pass held its view back because it can't cut through the numbers
    /// floor. Logged once per hold.
    pub(super) fn hold_below_numbers_floor(&mut self, why: &str) {
        if std::mem::replace(&mut self.numbers_floor_held, true) {
            return;
        }
        let Some(floor) = self.numbers_floor() else {
            return;
        };
        let reach = match (self.summarized_through(), self.last_summary_end()) {
            (Some(ordinal), Some(mid)) => format!("entry {ordinal} ({mid})"),
            _ => "nothing".into(),
        };
        tracing::warn!(
            session = %self.key.session,
            floor_ordinal = %floor.ordinal,
            floor_mid = %floor.mid,
            summary_reach = %reach,
            carried_head = %why,
            "ck-mc: session: no view: cut_before_numbers; views wait for a summary through the last entry without part numbers"
        );
    }

    /// A view cut through the numbers floor after views were held below it.
    pub(super) fn release_numbers_floor_hold(&mut self) {
        if !std::mem::take(&mut self.numbers_floor_held) {
            return;
        }
        tracing::info!(
            session = %self.key.session,
            "ck-mc: session: views publish again: the cut reaches past the history without part numbers"
        );
    }

    /// Take what a refused view's refusal says about history without part
    /// numbers. A `cut_before_numbers` refusal names the last such entry;
    /// when the index holds it, it becomes the numbers floor, so the next
    /// views wait for a summary through it instead of repeating the refused
    /// cut. Returns whether the refusal was `cut_before_numbers`: the drops
    /// the view carried were not at fault.
    pub(super) fn take_numbers_refusal(&mut self, version: u64, refusal: &ViewRefusal) -> bool {
        let ViewRefusal::CutBeforeNumbers { unknown_through } = refusal else {
            return false;
        };
        if !self.features.summarizer {
            // A session without a summarizer never cuts, so every view it
            // could build is refused the same way. It builds none until the
            // next Setup; its drops stay queued, blamed on nothing.
            if !std::mem::replace(&mut self.numbers_views_held, true) {
                tracing::warn!(
                    session = %self.key.session,
                    view_version = %version,
                    %unknown_through,
                    "ck-mc: session: runner refused a view with cut_before_numbers; this session has no summarizer to cut through it, so it builds no view until the next Setup"
                );
            }
            return true;
        }
        match self.index.ordinal_of(unknown_through) {
            Some(ordinal) => {
                tracing::info!(
                    session = %self.key.session,
                    view_version = %version,
                    %ordinal,
                    %unknown_through,
                    "ck-mc: session: runner refused a view with cut_before_numbers; views wait for a summary through the entry"
                );
                let floor = MoveFloor {
                    ordinal,
                    mid: unknown_through.clone(),
                };
                if self
                    .numbers_refused
                    .as_ref()
                    .is_none_or(|held| held.ordinal <= ordinal)
                {
                    self.numbers_refused = Some(floor);
                }
            }
            // Either the entry is before ck-mc's cut, which a newer view
            // already cuts past, or the index is still empty (right after a
            // restart). No floor is recorded either way: once the index is
            // read, it holds the marked entries and takes the floor from
            // them.
            None => tracing::info!(
                session = %self.key.session,
                view_version = %version,
                %unknown_through,
                "ck-mc: session: runner refused a view with cut_before_numbers at an entry ck-mc's index doesn't hold"
            ),
        }
        true
    }

    /// The summary that must come first while the summaries stop short of
    /// the numbers floor: due whatever the usage, from the summaries' end
    /// through the floor entry, within one run's cap, keeping its last
    /// compartment when it reaches the floor, so the cut can pass that entry.
    ///
    /// When the summarizer would find nothing to keep through the floor (a
    /// module notice, a message with nothing to render), the run reads on
    /// into later history, as the usual trigger would, never into the
    /// protected tail. When nothing outside that tail renders either, the
    /// entries through the floor count as covered for the cut: cutting them
    /// loses nothing a summary would keep.
    ///
    /// `None` when the floor is met (the usual trigger decides); `Some(None)`
    /// when that summary is due but can't start now (one is running, the
    /// last run made no progress, or an account or failure wait holds it).
    pub(super) fn numbers_summary_due(
        &mut self,
        settings: &Settings,
    ) -> Option<Option<run::Request>> {
        if !self.short_of_numbers_floor() {
            return None;
        }
        let floor = self.numbers_floor()?;
        if self.summarizing || self.has_pending_publication() || self.waits_for_new_history(false) {
            return Some(None);
        }
        let from = self.numbers_reach().map_or(1, |n| n + 1);
        let through_floor = floor.ordinal + 1;
        let usage = pass::usage(&self.pressure()).unwrap_or(0.0) * 100.0;
        let window = pass::usable_window(&self.conditions);
        let threshold = settings.execute_threshold_percentage;
        let force = pass::in_force_band(&self.pressure(), settings);
        let cap = trigger::per_run_cap(window, threshold, usage);
        let counter = self.counter();
        let entries = self.index.entries();
        let renders = |until: u64| {
            let low = entries.partition_point(|entry| entry.ordinal < from);
            let high = entries.partition_point(|entry| entry.ordinal < until);
            high > low && crate::summary::chunk::build(&entries[low..high], cap, counter).is_some()
        };
        let capped = trigger::cap_run(entries, entry_removed_tokens, from, through_floor, cap);
        let until = if renders(capped) {
            capped
        } else if renders(through_floor) {
            // What renders lies past one run's cap: the run reads through
            // the floor, or the next one would read the same nothing again.
            through_floor
        } else {
            let tail = trigger::protected_tail_tokens(window, threshold, usage);
            let beyond = trigger::cap_run(
                entries,
                entry_removed_tokens,
                from,
                trigger::tail_start(entries, entry_tokens, from, tail, force),
                cap.max(
                    entries
                        .iter()
                        .filter(|entry| entry.ordinal >= from && entry.ordinal < through_floor)
                        .map(entry_removed_tokens)
                        .sum::<u64>()
                        .saturating_add(1),
                ),
            );
            if beyond > through_floor && renders(beyond) {
                beyond
            } else {
                self.cover_through_numbers_floor(&floor);
                return None;
            }
        };
        let Some(admitted) = self.account_wait_admits(usage) else {
            return Some(None);
        };
        let requested = self
            .index
            .entries()
            .iter()
            .filter(|entry| entry.ordinal >= from && entry.ordinal < until)
            .map(entry_removed_tokens)
            .sum();
        let quota = crate::summary::drain::Usage {
            now: self.clock(),
            percentage: usage,
            threshold,
            force,
            usable: window,
            per_run_cap: cap,
        };
        // Past the automatic quota, as a person's wrapup is: no view can be
        // published until this summary lands.
        let Some(reservation) = self.drain.reserve_wrapup(&quota, requested) else {
            return Some(None);
        };
        self.reservation = Some(reservation);
        self.note_account_run(admitted, usage);
        let emergency = usage >= 95.0;
        self.run_start = Some(RunStart {
            lift: None,
            emergency,
        });
        tracing::info!(
            session = %self.key.session,
            floor_ordinal = %floor.ordinal,
            floor_mid = %floor.mid,
            "ck-mc: session: summarizing toward the last entry without part numbers before any view"
        );
        Some(Some(self.begin_summary(
            settings,
            from,
            until,
            emergency,
            until >= through_floor,
        )))
    }

    /// Nothing through the numbers floor, nor in later history outside the
    /// protected tail, renders anything a summary would keep: those entries
    /// count as covered, and the cut may pass them. Logged once per floor.
    fn cover_through_numbers_floor(&mut self, floor: &MoveFloor) {
        if self.numbers_covered.as_ref() == Some(floor) {
            return;
        }
        tracing::info!(
            session = %self.key.session,
            floor_ordinal = %floor.ordinal,
            floor_mid = %floor.mid,
            "ck-mc: session: entries through the last without part numbers hold nothing a summary would keep; the cut passes them without one"
        );
        self.numbers_covered = Some(floor.clone());
    }

    /// The next numbers summary to start at once after a run that made
    /// progress, so the runs follow one another to the floor as a person's
    /// wrap-up does, rather than one per notice while views stay held.
    pub(crate) fn pending_numbers_summary(&mut self, settings: &Settings) -> Option<run::Request> {
        if !self.compacting()
            || self.suspended
            || !self.index_ready
            || self.transcript_behind.is_some()
        {
            return None;
        }
        self.numbers_summary_due(settings).flatten()
    }

    /// The tool call still running at or before the numbers floor: its
    /// message's ordinal, the tool's name and the call id. A running call
    /// can't be cut (compaction contract W6.5), while the runner refuses any
    /// view that doesn't cut through the floor (T11), so no view can land
    /// until the call ends.
    pub(super) fn running_call_below_numbers_floor(&self) -> Option<(u64, String, String)> {
        let floor = self.numbers_floor()?;
        self.index
            .entries()
            .iter()
            .take_while(|entry| entry.ordinal <= floor.ordinal)
            .find_map(|entry| {
                entry.parts.iter().find_map(|part| match &part.body {
                    PartBody::Tool(tool) if !crate::neutral::is_finished(&tool.status) => {
                        Some((entry.ordinal, tool.name.clone(), tool.call_id.clone()))
                    }
                    _ => None,
                })
            })
    }
}
