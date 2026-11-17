//! The summarizer: when a run is due, the account wait, and what a finished
//! run publishes.

use super::*;

impl Session {
    /// Retain the unindexed evaluator as an oracle for differential and cost
    /// tests. Ordinary builds have no runtime switch for trigger evaluation.
    #[cfg(any(test, feature = "notice-cost-timing"))]
    pub fn use_legacy_summary_scan(&mut self, legacy: bool) {
        self.legacy_summary_scan = legacy;
    }

    fn legacy_summary_scan(&self) -> bool {
        #[cfg(any(test, feature = "notice-cost-timing"))]
        {
            self.legacy_summary_scan
        }
        #[cfg(not(any(test, feature = "notice-cost-timing")))]
        {
            false
        }
    }

    /// A summarizer run to start now, if one is due: the session has a
    /// summarizer, none is running, and the history it may read is worth a
    /// run at this usage.
    pub(super) fn summary_due(&mut self, settings: &Settings) -> Option<run::Request> {
        let _timing = crate::notice_cost_timing::span("trigger.summary_due");
        // No view may cut before history the runner serves without part
        // numbers, so a summary through it comes before any other.
        if let Some(due) = self.numbers_summary_due(settings) {
            return due;
        }
        if self.wrapup_target.is_some() {
            return self.wrapup_summary_due(settings);
        }
        let threshold = settings.execute_threshold_percentage;
        let usage = pass::usage(&self.pressure()).unwrap_or(0.0) * 100.0;
        let legacy = self.legacy_summary_scan();
        let cached = !legacy && self.features.summarizer && !self.summarizing;
        let from = self.summarized_through().map_or(1, |ordinal| ordinal + 1);
        let model = &self.conditions.model;
        let counter =
            crate::count::Counter::for_model(Some(&format!("{}/{}", model.provider, model.model)));
        if cached {
            let (identity, changed) = self.index.summary_changes();
            self.due_window.sync(
                self.index.entries(),
                identity,
                changed,
                from,
                counter,
                &mut self.scan_counts,
            );
        }
        let prompt = if !cached {
            self.index
                .entries()
                .iter()
                .rev()
                .find(|entry| trigger::is_meaningful_user(entry))
        } else {
            self.due_window.prompt(self.index.entries())
        }
        .map(|entry| (entry.ordinal, entry.mid.clone()));
        // A stale reading says nothing about usage, so it doesn't clear the
        // mark: the mark waits for a reading under the current view. A late
        // statement brought no reading, so its pass leaves the mark too.
        let reading_new = !self.reading_stale && !self.statement_late;
        if (usage < threshold && reading_new)
            || self
                .floor_pending_for
                .as_ref()
                .is_some_and(|mark| Some(mark) != prompt.as_ref())
        {
            self.floor_pending_for = None;
        }
        if !self.features.summarizer || self.summarizing {
            return None;
        }
        let window = pass::usable_window(&self.conditions);
        let force = pass::in_force_band(&self.pressure(), settings);
        let tail = trigger::protected_tail_tokens(window, threshold, usage);
        let entries = self.index.entries();
        let budget = trigger::trigger_budget(window, threshold);
        let cap = trigger::per_run_cap(window, threshold, usage);
        let quota = crate::summary::drain::Usage {
            now: self.clock(),
            percentage: usage,
            threshold,
            force,
            usable: ((window as f64 * threshold / 100.0).round() as u64).max(1),
            per_run_cap: cap,
        };
        // At or over the threshold, a pass that starts no summary logs why, so
        // a session that stays over the threshold without summarizing can be
        // explained from the log.
        let at_threshold = usage >= threshold;
        let session = self.key.session.clone();
        let held = |why: std::fmt::Arguments<'_>| {
            if at_threshold {
                tracing::info!(
                    "ck-mc: session {session}: no summary at {usage:.0}% (threshold {threshold:.0}%): {why}"
                );
            }
        };
        if self.drain.exhausted(&quota) {
            held(format_args!(
                "the drain quota is spent ({} tokens this window)",
                self.drain.spent
            ));
            return None;
        }
        // The trigger uses the session model; a routed summarizer gets its own
        // counter when the run starts. Only estimated counts need scaling.
        let calibration = counter.calibration();
        let ratio = calibration
            .prose_ratio
            .max(calibration.tools_ratio)
            .max(1.0);
        let scan_lines = (trigger::scan_budget(budget) as f64 / ratio).floor() as u64;
        let scaled_tail = (tail as f64 * if usage >= 95.0 { 0.25 } else { 0.5 }) as u64;
        let cached_bounds = (!legacy).then(|| {
            [(tail, false), (tail, true), (scaled_tail, true)].map(|(tokens, lift)| {
                (
                    tokens,
                    lift,
                    self.due_window.bounded(entries, from, tokens, lift, cap),
                )
            })
        });
        let bounded = |tail_tokens: u64, lift: bool| {
            if let Some(bounds) = &cached_bounds {
                return bounds
                    .iter()
                    .find(|(tokens, lifted, _)| *tokens == tail_tokens && *lifted == lift)
                    .expect("a protected-tail variant")
                    .2;
            }
            let until = trigger::tail_start(entries, entry_tokens, from, tail_tokens, lift);
            trigger::cap_run(entries, entry_removed_tokens, from, until, cap)
        };
        let after_drops = force
            .then(|| self.usage_after_drops(settings, usage))
            .flatten();
        let mut scan_at = |until: u64| -> Option<trigger::Scan> {
            if !legacy {
                let mut scan = self.due_window.scan(
                    entries,
                    from,
                    until,
                    scan_lines,
                    counter,
                    &mut self.scan_counts,
                )?;
                scan.tokens = (scan.tokens as f64 * ratio).ceil() as u64;
                return Some(scan);
            }
            let low = entries.partition_point(|entry| entry.ordinal < from);
            let high = entries.partition_point(|entry| entry.ordinal < until);
            let readable = &entries[low..high.max(low)];
            let chunk = self.scan_counts.build(readable, scan_lines, counter)?;
            Some(trigger::Scan {
                tokens: (chunk.token_estimate as f64 * ratio).ceil() as u64,
                has_more: chunk.has_more,
                commit_clusters: chunk.commit_clusters,
                messages: chunk.messages,
                raw_tokens: readable.iter().map(entry_tokens).sum(),
                removed_tokens: readable.iter().map(entry_removed_tokens).sum(),
            })
        };
        let pressure = trigger::Pressure {
            usage,
            threshold,
            force,
            usable_window: window,
            // Drops land only on a pass allowed to rebuild. A head whose
            // summary is still to come is allowed one in the force band, so
            // the usage after its drops counts there.
            after_drops,
        };
        let mut decide = |until: u64| {
            trigger::decide(
                &pressure,
                scan_at(until).as_ref(),
                budget,
                settings.commit_clusters,
            )
        };
        // Consume the mark before inspecting the lifted head. A head that has
        // shrunk cannot re-arm the same mark on this evaluation. A pass after
        // a stale reading leaves the mark for the next current one, since
        // lifting the floor is for a pass at the threshold.
        let taken_mark = if reading_new {
            self.floor_pending_for.take()
        } else {
            None
        };
        let lift_floor = taken_mark.is_some();
        let mut until = bounded(tail, force || lift_floor);
        let mut decision = decide(until);
        if decision.is_none() && force {
            // Too little to read in the force band: the protected tail shrinks
            // to a half, or a quarter from 95% (the plugin's emergency tail
            // scale).
            let scale = if usage >= 95.0 { 0.25 } else { 0.5 };
            until = bounded((tail as f64 * scale) as u64, true);
            decision = decide(until);
        }
        if decision.is_none() {
            let prompt_ordinal = prompt.as_ref().map(|(ordinal, _)| *ordinal);
            // At the threshold, a long turn's history after the person's
            // newest prompt cannot be summarized while that prompt stays raw.
            // Mark only when lifting that floor exposes a meaningful head;
            // the next notice may lift it once, while queued work waits for it.
            if !force
                && !lift_floor
                && usage >= threshold
                && prompt.is_some()
                && prompt.as_ref().map(|(_, mid)| mid) != self.floor_lifted_for.as_ref()
            {
                let lifted = bounded(tail, true);
                if lifted > until && decide(lifted).is_some() {
                    self.floor_pending_for = prompt;
                }
            }
            let lifted = bounded(tail, true);
            let weights: Vec<(u64, u64)> = entries
                .iter()
                .filter(|entry| entry.ordinal >= from)
                .take(4)
                .map(|entry| (entry.ordinal, entry_tokens(entry)))
                .collect();
            held(format_args!(
                "nothing to summarize: messages {from}..{until} (unfloored {lifted}), protected tail {tail} tokens, per-run cap {cap}, trigger budget {budget}, after drops {after_drops:?}, floor mark {}, prompt {:?}, first weights {weights:?}",
                self.floor_pending_for.is_some(),
                prompt_ordinal
            ));
            return None;
        }
        if self.waits_for_new_history(force) {
            held(format_args!(
                "the last run made no progress; waiting for new history"
            ));
            return None;
        }
        let Some(admitted) = self.account_wait_admits(usage) else {
            // The floor's lift is for the run after the wait.
            if lift_floor {
                self.floor_pending_for = taken_mark;
            }
            return None;
        };
        let requested: u64 = self
            .index
            .entries()
            .iter()
            .filter(|entry| entry.ordinal >= from && entry.ordinal < until)
            .map(entry_removed_tokens)
            .sum();
        let Some(reservation) = self.drain.reserve(&quota, requested) else {
            tracing::info!(
                "ck-mc: session {}: summary skipped: drain budget spent ({} tokens this window)",
                self.key.session,
                self.drain.spent
            );
            return None;
        };
        self.reservation = Some(reservation);
        self.note_account_run(admitted, usage);
        self.run_start = Some(RunStart {
            lift: lift_floor.then(|| SpentLift {
                mark: taken_mark,
                lifted_before: self.floor_lifted_for.clone(),
            }),
            emergency: usage >= 95.0,
        });
        // The lift is spent only by a run that actually starts.
        if lift_floor {
            self.floor_lifted_for = prompt.map(|(_, mid)| mid);
        }
        Some(self.begin_summary(settings, from, until, force, false))
    }

    /// Manual and automatic summaries share their request, routing and publication path.
    pub(super) fn begin_summary(
        &mut self,
        settings: &Settings,
        from: u64,
        until: u64,
        emergency: bool,
        force_keep_last_compartment: bool,
    ) -> run::Request {
        let memory_enabled =
            self.memory_admissions(settings) && self.writable_memory_level().is_some();
        let requested: u64 = self
            .index
            .entries()
            .iter()
            .filter(|entry| entry.ordinal >= from && entry.ordinal < until)
            .map(entry_removed_tokens)
            .sum();
        self.summarizing = true;
        tracing::info!(
            "ck-mc: session {}: summary started over messages {from}..{until} (~{requested} tokens)",
            self.key.session
        );
        run::Request {
            limits: self.limits,
            session: self.key.clone(),
            // Retries and turn two belong to one summary attempt; keep them
            // on one harness even if Setup changes during the run.
            child_harness: self.child_harness.clone(),
            from,
            until,
            project_root: self.workdir.clone(),
            project: self.writable_memory_level().map(str::to_owned),
            summaries: self.summaries.clone(),
            language: settings.language.clone(),
            memory_enabled,
            auto_promote: settings.auto_promote,
            emergency,
            force_keep_last_compartment,
            memory_context: self.memory_context.clone(),
            keep_subagents: settings.keep_subagents,
            agent_id: self.agent_id.clone(),
        }
    }

    /// The session's clock for the drain quota: when the runner wrote the
    /// newest message, which a notice follows at once. Decisions then follow
    /// the transcript alone, as every other decision here does; the wall
    /// clock is used only before the first message.
    pub(super) fn clock(&self) -> i64 {
        self.index
            .entries()
            .last()
            .map(|entry| entry.written_at as i64)
            .filter(|written| *written > 0)
            .unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |elapsed| elapsed.as_millis() as i64)
            })
    }

    /// Usage once this pass's drops land: the model's queued drops and the
    /// reasoning over its budget, as a share of the transcript the model
    /// sees, applied to the reported usage (`compartment-trigger.ts`,
    /// `estimateProjectedPostDropPercentage`). `None` when nothing would go.
    pub(super) fn usage_after_drops(&self, settings: &Settings, usage: f64) -> Option<f64> {
        let edited = self.edited(self.cut);
        let context = lanes::Context {
            index: &self.index,
            edited: &edited,
            protected_tools: &settings.protected_tools,
            keep_first_message: self.features.keep_first_message,
            signed_floor: self.signed_floor(),
        };
        // Only queued drops this pass can land count: one in the protected
        // tail waits for it to move on, as `build` does and as the plugin
        // credits only eligible pending drops.
        let usable = pass::usable_window(&self.conditions);
        let floor = settings
            .protected_tokens
            .unwrap_or_else(|| lanes::default_protected_tokens(usable));
        let cutoff = lanes::protected_cutoff(&context, floor);
        let mut wanted: Vec<(lanes::PartKey, lanes::Shape)> = self
            .queued
            .iter()
            .filter(|key| !lanes::in_protected_tail(&context, key, cutoff))
            .map(|key| (key.clone(), lanes::Shape::Requested))
            .collect();
        let model = &self.conditions.model;
        wanted.extend(lanes::reasoning_over_budget(
            &context,
            settings.keep_reasoning_tokens,
            model.provider.contains("anthropic") || model.model.contains("claude"),
        ));
        let (_, covered) = lanes::drop_ops(&context, &wanted);
        let freed = freed_tokens(&context, &covered);
        let total: u64 = self
            .index
            .entries()
            .iter()
            .flat_map(|entry| entry.parts.iter().map(move |part| (entry, part)))
            .filter(|(entry, part)| !edited.covers(&entry.mid, &part.id))
            .filter(|(entry, part)| !lanes::stripped_by_floor(context.signed_floor, entry, part))
            .map(|(_, part)| tokens::part(part))
            .sum();
        (freed > 0 && total > 0).then(|| {
            let remaining = total.saturating_sub(freed) as f64;
            let projected = usage * (1.0 - (freed as f64 / total as f64).min(1.0));
            let window = usable as f64;
            if window == 0.0 {
                return projected;
            }
            // Keep the transcript-ratio projection, but don't let notes added
            // since the measured request make the drops look sufficient.
            let fixed = (projected * window / 100.0 - remaining).max(0.0);
            projected + (self.notes.fixed_part(fixed) - fixed) / window * 100.0
        })
    }

    /// Whether a run would read the same history a run before it failed to
    /// summarize, as the plugin's `historian-history-wait.ts`: it waits for a
    /// newer message, so a failing summary does not pay for the same input on
    /// every pass. In the force band it may try once more.
    pub(super) fn waits_for_new_history(&mut self, force: bool) -> bool {
        let Some((newest, retried)) = &mut self.no_progress else {
            return false;
        };
        let current = self.index.entries().last().map(|entry| entry.mid.as_str());
        if current != Some(newest.as_str()) {
            self.no_progress = None;
            return false;
        }
        if force && !*retried {
            *retried = true;
            return false;
        }
        true
    }

    /// A run published nothing: wait for newer history before the next.
    fn record_no_progress(&mut self, settings: &Settings) {
        let Some(newest) = self.index.entries().last().map(|entry| entry.mid.clone()) else {
            return;
        };
        let force = pass::in_force_band(&self.pressure(), settings);
        let retried = match &self.no_progress {
            Some((previous, retried)) if *previous == newest => *retried || force,
            _ => force,
        };
        self.no_progress = Some((newest, retried));
    }

    /// Whether the account wait lets the run due now start, and how. `None`
    /// holds it back; the first run held back in a wait is logged, later
    /// ones are not. From 95% usage, where a primary session's turns wait
    /// for its summary, one run per newest message may start inside the
    /// wait: the account may have recovered, and the alternative is a
    /// refused turn. A refused try leaves nothing to retry until a newer
    /// message arrives.
    pub(super) fn account_wait_admits(&mut self, usage: f64) -> Option<AccountAdmit> {
        let now = crate::summary::account_wait::now_ms();
        let newest = self.index.entries().last().map(|entry| entry.mid.clone());
        let session = &self.key.session;
        let Some(waiting) = &mut self.account_wait else {
            return Some(AccountAdmit::NoWait);
        };
        if !waiting.holds(now) {
            return Some(AccountAdmit::AfterWait);
        }
        if usage >= 95.0 && newest.is_some() && waiting.emergency_at != newest {
            return Some(AccountAdmit::Emergency(newest));
        }
        if !waiting.skip_logged {
            waiting.skip_logged = true;
            tracing::info!(
                "ck-mc: session {session}: summary skipped at {usage:.0}%: summaries wait until {} ms since the epoch ({} after the {}); no summary run starts before then",
                waiting.refusal.until_ms,
                waiting.refusal.code,
                waiting.refusal.send.name()
            );
        }
        None
    }

    /// A run [`Session::account_wait_admits`] let through has started.
    pub(super) fn note_account_run(&mut self, admitted: AccountAdmit, usage: f64) {
        let session = &self.key.session;
        match admitted {
            AccountAdmit::NoWait => {}
            AccountAdmit::AfterWait => {
                if let Some(waiting) = self.account_wait.take() {
                    tracing::info!(
                        "ck-mc: session {session}: the first summary run after the account wait started (the wait ran until {} ms since the epoch)",
                        waiting.refusal.until_ms
                    );
                }
            }
            AccountAdmit::Emergency(newest) => {
                if let Some(waiting) = &mut self.account_wait {
                    waiting.emergency_at = newest;
                    tracing::info!(
                        "ck-mc: session {session}: summary run started at {usage:.0}% inside the account wait (until {} ms since the epoch): one try for this history",
                        waiting.refusal.until_ms
                    );
                }
            }
        }
    }

    /// The runner held a summarizer send back until an account has room:
    /// no summary run starts for this session before the time it named. A
    /// try at emergency usage that met it again keeps its mark, so the next
    /// such try waits for newer history.
    pub(crate) fn account_refused(&mut self, wait: crate::summary::account_wait::AccountWait) {
        self.account_refused_at(wait, None);
    }

    /// [`Session::account_refused`] for a run that met the wait with
    /// `emergency_at` as its history: a run started at emergency usage,
    /// which asks again only once newer history arrives. A refusal received
    /// before the session's last served run is ignored: a second turn's wait
    /// can arrive after a later first turn found the accounts open again.
    fn account_refused_at(
        &mut self,
        wait: crate::summary::account_wait::AccountWait,
        emergency_at: Option<String>,
    ) {
        if wait.at_ms < self.last_served_ms {
            return;
        }
        let emergency_at = emergency_at.or_else(|| {
            self.account_wait
                .take()
                .and_then(|waiting| waiting.emergency_at)
        });
        let seconds = (wait.until_ms - crate::summary::account_wait::now_ms()).max(0) / 1000;
        tracing::info!(
            "ck-mc: session {}: summaries wait until {} ms since the epoch (in {seconds} s): the runner held back the {} with {}",
            self.key.session,
            wait.until_ms,
            wait.send.name(),
            wait.code
        );
        self.account_wait = Some(crate::summary::account_wait::Waiting::new(
            wait,
            emergency_at,
        ));
    }

    /// The session's summaries wait for an account right now.
    pub(super) fn summaries_wait_for_account(&self) -> bool {
        self.account_wait
            .as_ref()
            .is_some_and(|waiting| waiting.holds(crate::summary::account_wait::now_ms()))
    }

    /// A summarizer run ended. New summaries are stored, and when usage is at
    /// the execute threshold the view that shows them is built now: the pass
    /// that held its work for this summary is waiting on it.
    ///
    /// Returns the conversation the two-pass historian's second turn
    /// continues, once its first turn's summaries and candidates are stored.
    pub async fn summary_finished<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        result: Result<Option<run::Summarized>, run::SummaryError>,
        now_ms: i64,
    ) -> Option<run::Continuation> {
        self.summarizing = false;
        let reservation = self.reservation.take();
        let started = self.run_start.take();
        let (validated, publication, continuation) = match result {
            Ok(Some(summarized)) => {
                // The runner served the summarizer, so whatever account wait
                // an earlier send met is over, and an older one that arrives
                // late is stale.
                self.account_wait = None;
                self.last_served_ms = crate::summary::account_wait::now_ms();
                (
                    summarized.validated,
                    summarized.publication,
                    summarized.continuation,
                )
            }
            Ok(None) => {
                if let Some(reservation) = reservation {
                    self.drain.release(reservation);
                }
                self.record_no_progress(settings);
                return None;
            }
            // A wait or a proven never-run send says nothing against the
            // summarizer. Release its reservation, restore the saved
            // protected-tail floor state, and use the retry deadline
            // without recording a summary failure.
            Err(run::SummaryError::AccountWait(wait) | run::SummaryError::NeverRan(wait)) => {
                if let Some(reservation) = reservation {
                    self.drain.release(reservation);
                }
                let mut emergency_at = None;
                if let Some(started) = started {
                    // A floor lift the run spent comes back for the run after
                    // the wait, as when the wait holds a run back before it
                    // starts.
                    if let Some(lift) = started.lift {
                        self.floor_pending_for = lift.mark;
                        self.floor_lifted_for = lift.lifted_before;
                    }
                    // A run started at emergency usage was that history's
                    // one try.
                    if started.emergency {
                        emergency_at = self.index.entries().last().map(|entry| entry.mid.clone());
                    }
                }
                self.account_refused_at(wait, emergency_at);
                return None;
            }
            // The summarizer failed: the reservation stays spent, so a broken
            // summarizer does not run again on every pass. The wait for new
            // history is only for a run that published nothing (the plugin's
            // `historian-history-wait.ts`): a provider that recovers may run
            // again on the same history while the quota lasts.
            Err(run::SummaryError::Failed(error)) => {
                self.app.failures += 1;
                self.app.last_error = Some(error.clone());
                tracing::warn!(
                    "ck-mc: session {}: summary failed: {error}",
                    self.key.session
                );
                let now = self.clock();
                self.drain.record_failure(now);
                return None;
            }
        };
        // A revert during the run may have removed what it summarized.
        let present = |mid: &str| self.index.entries().iter().any(|entry| entry.mid == mid);
        if validated.compartments.is_empty()
            || !validated.compartments.iter().all(|summary| {
                present(&summary.end_message_id) && present(&summary.start_message_id)
            })
        {
            if let Some(reservation) = reservation {
                self.drain.release(reservation);
            }
            self.record_no_progress(settings);
            return None;
        }
        // The facts are candidates for the second turn, stored with the
        // publication; they never become memories here. A session with no
        // memory level it can write to keeps no publication, and its facts
        // are dropped.
        if let Some(db) = &self.db {
            // The plugin stores one primer candidate per run, the first.
            let primer = match (&self.project, validated.primer_candidates.first()) {
                (Some(project), Some(candidate)) => {
                    let origin = candidate.origin_compartment_index;
                    let source = origin
                        .and_then(|at| at.checked_sub(1))
                        .and_then(|index| validated.compartments.get(index as usize))
                        .or(validated.compartments.first());
                    let source_time = source
                        .and_then(|summary| {
                            self.index
                                .entries()
                                .iter()
                                .find(|entry| entry.mid == summary.start_message_id)
                        })
                        .map_or(now_ms, |entry| entry.written_at as i64);
                    Some(crate::context_db::PrimerSource {
                        project: project.id.clone(),
                        question: candidate.question.clone(),
                        origin,
                        source_time,
                    })
                }
                _ => None,
            };
            let observations = validated
                .user_observations
                .iter()
                .map(|observation| {
                    let source = observation
                        .origin_compartment_index
                        .and_then(|at| at.checked_sub(1))
                        .and_then(|index| validated.compartments.get(index as usize));
                    let (start, end) = match source {
                        Some(summary) => (summary.start_message, summary.end_message),
                        None => (
                            validated
                                .compartments
                                .first()
                                .map_or(0, |c| c.start_message),
                            validated.compartments.last().map_or(0, |c| c.end_message),
                        ),
                    };
                    crate::context_db::ObservationSource {
                        category: observation.category.clone(),
                        content: observation.content.clone(),
                        start_ordinal: start,
                        end_ordinal: end,
                        profile: self
                            .authority
                            .as_ref()
                            .and_then(|authority| authority.profile.clone()),
                        project_id: self
                            .memory_context
                            .as_ref()
                            .and_then(|context| context.project_id.clone()),
                        workspace_id: self
                            .memory_context
                            .as_ref()
                            .and_then(|context| context.workspace_id.clone()),
                    }
                })
                .collect();
            let recall = crate::context_db::Recall {
                events: validated.events.clone(),
                primer,
                observations,
                project: self.project.as_ref().map(|project| project.id.clone()),
            };
            if let Err(error) = db.publish_summaries(
                &self.key.harness,
                &self.key.session,
                &validated.compartments,
                publication.as_ref(),
                &recall,
                now_ms,
            ) {
                self.app.failures += 1;
                self.app.last_error = Some(error.clone());
                tracing::warn!(
                    "ck-mc: session {}: storing summaries failed: {error}",
                    self.key.session
                );
                self.record_no_progress(settings);
                return None;
            }
        }
        self.no_progress = None;
        self.app_projection.summaries_dirty = true;
        self.summaries
            .extend(validated.compartments.iter().map(|compartment| {
                let mut stored = StoredCompartment::from(compartment);
                stored.created_at = now_ms;
                stored
            }));
        if !validated.compartments.is_empty() {
            self.summary_unshown = true;
            tracing::info!(
                "ck-mc: session {}: {} summaries published, through message {}",
                self.key.session,
                validated.compartments.len(),
                validated
                    .compartments
                    .last()
                    .map_or(0, |compartment| compartment.end_message)
            );
        }
        // The signed-thinking hold applies here as on a notice: the summary
        // lands on the next pass the hold lets through.
        let execute = {
            let pressure = self.pressure();
            pass::at_execute(&pressure, settings)
                && !pass::signed_thinking_hold(
                    self.index.entries(),
                    &pressure,
                    settings,
                    self.signed_floor(),
                )
        };
        if execute {
            let (view, _) = self.build_now(client, settings).await;
            if let Some(view) = view {
                self.publish(client, view).await;
            }
        }
        if self.writable_memory_level().is_none() {
            tracing::info!(
                "ck-mc: session {}: no second summary turn: the session has no memory level it can write to",
                self.key.session
            );
        }
        continuation.filter(|_| self.db.is_some())
    }

    /// The second turn a two-pass summary's first turn calls for.
    pub fn turn_two_job(
        &self,
        settings: &Settings,
        continuation: run::Continuation,
    ) -> Option<crate::summary::two_pass::turn_two::Job> {
        Some(crate::summary::two_pass::turn_two::Job {
            owner: self.key.clone(),
            project: self.writable_memory_level()?.to_owned(),
            project_root: self.workdir.clone(),
            continuation,
            memory_enabled: self.memory_admissions(settings),
            auto_promote: settings.auto_promote,
            embedding: settings.embedding.clone(),
            authority: self.authority.clone(),
            agent_id: self.agent_id.clone(),
        })
    }
}
