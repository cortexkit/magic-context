//! Creating, restoring and freeing a session, and Setup.

use super::*;

impl Session {
    pub(super) fn counter(&self) -> crate::count::Counter {
        crate::count::Counter::for_model(Some(&format!(
            "{}/{}",
            self.conditions.model.provider, self.conditions.model.model
        )))
    }

    pub(crate) fn publish_app(&mut self, app: &crate::app_read::AppRead, checkpoint: bool) {
        self.app_publish_update(app, checkpoint);
    }
    pub fn new(
        route: &Route,
        request: &SetupRequest,
        features: Features,
        db: Option<Arc<ContextDb>>,
    ) -> Self {
        Self {
            command_answers: Default::default(),
            wrapup_target: None,
            app: Default::default(),
            app_projection: Default::default(),
            app_decisions: Vec::new(),
            app_decisions_revision: 0,
            app_decisions_unsaved: Default::default(),
            app_cause: "publication".into(),
            db,
            project: route.project.clone(),
            workdir: folder_of(route),
            agent_id: route.agent_id.clone(),
            key: route.session.clone(),
            features,
            preset: crate::catalog::Preset::parse(&request.preset)
                .unwrap_or(crate::catalog::Preset::Head),
            reminder_counter: 0,
            render_failed: Default::default(),
            conditions: conditions_of(request),
            limits: crate::reads::Limits::from_setup(request.limits.as_ref()),
            window_over_budget: false,
            warned_no_prompt: false,
            notes: Default::default(),
            surface_tokens: (None, None),
            threshold: (
                crate::pass::Settings::default().execute_threshold_percentage,
                "default",
            ),
            index: Index::default(),
            view_validation: Default::default(),
            search_dirty_from: None,
            search_reconcile_from: None,
            scan_counts: crate::summary::chunk::CountCache::default(),
            due_window: crate::summary::due::Window::default(),
            #[cfg(any(test, feature = "notice-cost-timing"))]
            legacy_summary_scan: false,
            index_ready: true,
            transcript_behind: None,
            suspended: false,
            child_harness: request.child_harness.clone(),
            view_anchor: request.view_anchor == Some(true),
            latest: None,
            version: 0,
            newest_applied: 0,
            reading_stale: false,
            ignored_reading: None,
            prompt_views_untrusted: false,
            spent_reading: None,
            queued: BTreeSet::new(),
            reclaim_bookmark: 0,
            next_reclaim_bookmark: None,
            notice_reclaim_bookmark: 0,
            notice_keep: false,
            next_notice_reclaim_bookmark: None,
            emergency_latched: false,
            next_latch: false,
            next_rearm: false,
            summary_unshown: false,
            latest_unknown: false,
            summaries_missing: None,
            next_keep: None,
            failed_parts: BTreeSet::new(),
            keep_requested: false,
            pending_keep: None,
            seq: 0,
            summaries: Summaries::default(),
            summaries_unread: false,
            head_summaries: None,
            baseline: None,
            next_baseline: None,
            next_flush: false,
            caveman: lanes::CavemanState::default(),
            next_caveman: None,
            next_covered: Vec::new(),
            refused_once: BTreeSet::new(),
            transcript_retry: None,
            summarizing: false,
            pending_publication: None,
            account_wait: None,
            run_start: None,
            last_served_ms: 0,
            fold_due: false,
            head_stale: false,
            marker_possible: false,
            lost_view_due: false,
            lost_view_offers: 0,
            lost_view_offer: None,
            nudges: crate::nudges::State::default(),
            clock_note: crate::clock_note::State::default(),
            cut: None,
            pruned_turns: 0,
            tools_only: false,
            no_progress: None,
            floor_lifted_for: None,
            floor_pending_for: None,
            drain: Default::default(),
            reservation: None,
            image_outputs: std::collections::BTreeMap::new(),
            memory_context: None,
            authority: None,
            head_classes: None,
            unconfirmed: Vec::new(),
            store: None,
            mural_image: None,
            move_floor: None,
            move_floor_held: false,
            numbers_refused: None,
            numbers_floor_held: false,
            numbers_covered: None,
            numbers_views_held: false,
            numbers_running_logged: None,
            numbers_unknown_tags: BTreeSet::new(),
            reoffer_pending: false,
            signed_floor: None,
            disproved_floor: None,
            statement_seq: None,
            statement_epoch: None,
            statement_late: false,
            late_statements: 0,
            runner_reads: RunnerReads::default(),
        }
    }

    /// Save the session's state here before each view it hands over.
    pub fn set_store(&mut self, store: Option<Arc<crate::store::Store>>) {
        if let Some(store) = &store {
            self.app_decisions = store.app_decisions(&self.key);
            self.app_decisions_revision += 1;
        }
        self.store = store;
    }

    /// Whether the session's memory context is known yet.
    pub fn has_memory_context(&self) -> bool {
        self.memory_context.is_some()
    }

    /// Switch the session to the workspace Entorhinal now places its project
    /// in (`project` is the project that answer was for; an answer for another
    /// project changes nothing). A head runs for months, so a move of its
    /// project to another workspace has to reach it. No fold is forced: the
    /// old workspace's memories leave the head and the new one's arrive as
    /// memory-update lines in `m[1]`, like any memory change, and the next
    /// fold chooses again. The profile pin stays as it was fixed. Returns
    /// whether the workspace changed.
    pub fn follow_workspace(&mut self, project: Option<&str>, workspace: Option<String>) -> bool {
        let Some(context) = self.memory_context.as_mut() else {
            return false;
        };
        if context.project_id.as_deref() != project || context.workspace_id == workspace {
            return false;
        }
        tracing::info!(
            "ck-mc: session {}: its project {} is now in workspace {}, was {}; the head shows the change at its next memory update",
            self.key.session,
            project.unwrap_or("(none)"),
            workspace.as_deref().unwrap_or("(none)"),
            context.workspace_id.as_deref().unwrap_or("(none)"),
        );
        context.workspace_id = workspace;
        self.authority = crate::memory_levels::Authority::from_context(context);
        if let Some(store) = &self.store {
            store.set_memory_workspace(&self.key, context.workspace_id.as_deref());
        }
        true
    }

    /// Take the session's memory context. Only its workspace changes
    /// afterwards ([`Self::follow_workspace`]).
    pub fn set_memory_context(&mut self, context: crate::memory_profile::MemoryContext) {
        if self.memory_context.is_none() {
            self.authority = crate::memory_levels::Authority::from_context(&context);
            self.memory_context = Some(context);
            self.head_classes = None;
        }
    }

    /// Whether the summarizer may read and admit memories: configured, and
    /// the session's memory profile was not refused. A refused profile keeps
    /// existing memories in the head.
    pub(super) fn memory_admissions(&self, settings: &Settings) -> bool {
        settings.memory_enabled
            && !self.memory_context.as_ref().is_some_and(|context| {
                matches!(
                    context.profile.state.as_str(),
                    "unresolved" | "conflict" | "blocked" | "unavailable"
                )
            })
    }

    /// The memory level a summary's facts can become memories in: today only
    /// the session's project, by its id. A session without one has no level
    /// it can write to: its summarizer asks for no facts, keeps no records
    /// for a second turn, and runs no second turn.
    pub(super) fn writable_memory_level(&self) -> Option<&str> {
        self.project.as_ref().map(|project| project.id.as_str())
    }

    /// A session that only calls tools: a runner offers it `ctx_search`,
    /// `ctx_memory` and `ctx_note` without having Magic Context compact it, so
    /// it never had a Setup. Its tools read the project from the route; it has
    /// no transcript, views or summaries.
    pub fn tools_only(route: &Route, db: Option<Arc<ContextDb>>) -> Self {
        let request = SetupRequest::new(
            String::new(),
            cortexkit_role_compaction::setup::ModelRef::new(String::new(), String::new()),
            0,
            0,
            cortexkit_role_compaction::rules::ProviderRules::new(
                cortexkit_role_compaction::rules::SignedParts::None,
                cortexkit_role_compaction::rules::EditCost::Suffix,
            ),
            Vec::new(),
            0,
        );
        let mut session = Self::new(route, &request, Features::NONE, db);
        session.tools_only = true;
        session
    }

    /// Whether Magic Context compacts this session, including state restored
    /// before this process receives Setup, rather than only serving its tools.
    pub fn compacting(&self) -> bool {
        !self.tools_only
    }

    pub fn key(&self) -> &SessionRef {
        &self.key
    }

    /// Use the same preset and configuration policy as the runner's catalog.
    pub(crate) fn serves_tool(&self, name: &str, config: &crate::catalog::CatalogConfig) -> bool {
        if self.tools_only && matches!(name, "ctx_reduce" | "ctx_expand" | "ctx_keep") {
            return true; // These calls retain their explanatory tools-only refusal.
        }
        let mut config = config.clone();
        // A disabled memory tool has its own explanatory refusal. Preset
        // membership is still checked before that refusal is returned.
        if name == "ctx_memory" {
            config.memory_enabled = true;
        }
        crate::catalog::served_tools(
            self.preset,
            !self.tools_only,
            &serde_json::Map::new(),
            &config,
        )
        .iter()
        .any(|tool| tool.name == name)
    }

    /// What the session's settings depend on: its project folder, its model
    /// as `provider/model`, and its usable window.
    pub fn config_inputs(&self) -> (Option<&str>, String, u64) {
        let model = &self.conditions.model;
        (
            self.workdir.as_deref(),
            format!("{}/{}", model.provider, model.model),
            crate::pass::usable_window(&self.conditions),
        )
    }

    /// What must survive a restart.
    pub fn durable(&self) -> crate::store::Durable {
        let _timing = crate::notice_cost_timing::span("session.durable");
        crate::store::Durable {
            command_answers: self.command_answers_for_save(),
            wrapup_target: self.wrapup_target.clone(),
            app: self.app.clone(),
            compaction: (!self.tools_only).then(|| (self.features, self.conditions.clone())),
            preset: (!self.tools_only).then(|| self.preset.as_str().to_owned()),
            pending_keep: self.pending_keep.clone(),
            head_stale: self.head_stale,
            marker_possible: self.marker_possible,
            reminder_counter: self.reminder_counter,
            render_failed: self.render_failed.clone(),
            version: self.version,
            newest_applied: self.newest_applied,
            reading_stale: self.reading_stale,
            ignored_reading: self.ignored_reading,
            prompt_views_untrusted: self.prompt_views_untrusted,
            spent_reading: self.spent_reading,
            notes: self.notes.clone(),
            queued: self.queued.clone(),
            reclaim_bookmark: self.reclaim_bookmark,
            notice_reclaim_bookmark: self.notice_reclaim_bookmark,
            emergency_latched: self.emergency_latched,
            keep_requested: self.keep_requested,
            baseline: self.baseline.clone(),
            nudges: self.nudges.clone(),
            clock_note: self.clock_note.clone(),
            cut: self.cut,
            pruned_turns: self.pruned_turns,
            caveman: self.caveman.clone(),
            drain: self.drain.clone(),
            no_progress: self.no_progress.clone(),
            floor_lifted_for: self.floor_lifted_for.clone(),
            floor_pending_for: self.floor_pending_for.clone(),
            unconfirmed: self.unconfirmed.clone(),
            summary_unshown: self.summary_unshown,
            move_floor: self.move_floor.clone(),
            signed_floor: self.signed_floor.clone(),
            numbers_unknown_tags: self.numbers_unknown_tags.clone(),
        }
    }

    /// Take back what a previous ck-mc process saved for the session.
    pub fn restore(&mut self, durable: crate::store::Durable) {
        self.command_answers = durable.command_answers;
        self.wrapup_target = durable.wrapup_target;
        self.app = durable.app.clone();
        self.tools_only = false;
        if let Some(preset) = durable
            .preset
            .as_deref()
            .and_then(crate::catalog::Preset::parse)
        {
            self.preset = preset;
        }
        if let Some((features, conditions)) = durable.compaction {
            self.features = features;
            self.conditions = conditions;
        }
        self.pending_keep = durable.pending_keep;
        self.head_stale = durable.head_stale;
        self.marker_possible = durable.marker_possible;
        self.reminder_counter = durable.reminder_counter;
        self.render_failed = durable.render_failed;
        self.version = durable.version;
        self.newest_applied = durable.newest_applied;
        self.reading_stale = durable.reading_stale;
        self.ignored_reading = durable.ignored_reading;
        self.prompt_views_untrusted = durable.prompt_views_untrusted;
        self.spent_reading = durable.spent_reading;
        self.notes = durable.notes;
        self.queued = durable.queued;
        self.reclaim_bookmark = durable.reclaim_bookmark;
        self.notice_reclaim_bookmark = durable.notice_reclaim_bookmark;
        self.emergency_latched = durable.emergency_latched;
        self.keep_requested = durable.keep_requested;
        self.baseline = durable.baseline;
        self.nudges = durable.nudges;
        self.clock_note = durable.clock_note;
        self.cut = durable.cut;
        self.pruned_turns = durable.pruned_turns;
        self.caveman = durable.caveman;
        self.drain = durable.drain;
        self.no_progress = durable.no_progress;
        self.floor_lifted_for = durable.floor_lifted_for;
        self.floor_pending_for = durable.floor_pending_for;
        self.unconfirmed = durable.unconfirmed;
        // Whether the runner still holds a view it accepted before the
        // restart is unknown until Setup offers the view again (see
        // `Unconfirmed::accepted`).
        for pending in &mut self.unconfirmed {
            pending.accepted = false;
            pending.excused.clear();
        }
        // Like refused_once, the retry guard survives in an unconfirmed
        // view's rollback snapshot, not in a separate store column.
        self.transcript_retry = self
            .unconfirmed
            .last()
            .and_then(|pending| pending.before.transcript_retry);
        self.summary_unshown = durable.summary_unshown;
        self.move_floor = durable.move_floor;
        self.signed_floor = durable.signed_floor;
        self.numbers_unknown_tags = durable.numbers_unknown_tags;
        // A view handed over before the restart is the one ck-mc expects
        // the runner to show; Setup settles it.
        self.latest = self.unconfirmed.last().map(|pending| pending.view.clone());
        // Views are cumulative, and ck-mc doesn't store the confirmed one:
        // it reads it back from the runner (`session.applied_view`). Until
        // that read succeeds no view is built, or the next one would carry
        // none of the earlier edits and every dropped part would come back.
        self.latest_unknown = self.latest.is_none() && self.version > 0;
        self.distrust_state_ahead_of_summaries();
        self.share_baseline_text();
        // The first read after a restart starts at the cut: nothing before
        // it is visible to the model.
        self.index = Index::starting_at(self.cut.unwrap_or(1));
        self.index_ready = false;
    }

    /// Restore the transcript for a tool that arrived before the runner's
    /// first notice. This does not count as Setup in the current process.
    pub async fn restore_for_tools<C: RunnerClient>(&mut self, client: &C) {
        self.index_ready = self.read_until(client, None, true).await;
    }

    /// The session without what [`Session::resume_quiet`] reads again from
    /// the stores or builds again, when nothing of it is in flight; the
    /// session unchanged otherwise. It drops its summaries but the newest,
    /// the apps' projection but the head they read, and the caches derived
    /// from those, the summarizer's trigger window included. It keeps what
    /// its next job needs from the runner: the transcript index, the view
    /// and the caches that check the next one, so the resumed session reads
    /// nothing from the runner. Every other field stays as it is, those kept
    /// in memory only included (the statement epoch and stamp, the notice
    /// number, the account wait, the bound on an immediate retry and the
    /// rest), so the resumed session decides as one never freed. The apps'
    /// checkpoint is saved first: the projection is built again on resuming,
    /// and the apps read the saved one meanwhile.
    ///
    /// In flight means a view the runner has not confirmed or one waiting to
    /// be offered again, a summary run, a transcript held behind the
    /// summaries, ck-mc's newest view not being the one the runner last
    /// reported applying, or app decisions or a checkpoint not saved. An
    /// index or runner's view a failed read left unknown, and a session whose
    /// runner refused ck-mc as its compaction provider (`suspended`), are not
    /// in flight: the resumed session keeps them for its next job, as a
    /// session never freed does. What only the worker
    /// sees (its queue, its saved state, the search index) is the worker's
    /// to check.
    pub(crate) fn quiet_carry(mut self: Box<Self>) -> Result<QuietCarry, Box<Self>> {
        self.app_checkpoint_if_due(true);
        let quiet = self.compacting()
            && self.unconfirmed.is_empty()
            && !self.reoffer_pending
            && !self.summarizing
            && !self.has_pending_publication()
            && self.run_start.is_none()
            && self.reservation.is_none()
            && self.transcript_behind.is_none()
            // Without a view of ck-mc's (one another provider owns, or none)
            // there is no view to compare.
            && self
                .latest
                .as_ref()
                .is_none_or(|view| view.version == self.newest_applied)
            && self.app_decisions_unsaved.is_empty()
            && self.app_snapshot_deadline().is_none();
        if !quiet {
            return Err(self);
        }
        self.drop_quiet_summaries();
        self.head_summaries = None;
        // Caches of what the summarizer's trigger derives from the index,
        // built again when it next looks.
        self.scan_counts = Default::default();
        self.due_window = Default::default();
        let head_read = std::mem::take(&mut self.app_projection.head_read);
        self.app_projection = Default::default();
        self.app_projection.head_read = head_read;
        self.app_decisions = Vec::new();
        Ok(QuietCarry(self))
    }

    /// The session `carry` was made from, with what the stores hold of it
    /// read again: its summaries from `context.db` and the apps' decisions
    /// from `mode3.db`. Nothing is read from the runner: the carry kept the
    /// transcript index and the view. Summaries that can't be read leave the
    /// session marked unread ([`Session::summaries_ready`]).
    pub(crate) fn resume_quiet(carry: QuietCarry) -> Self {
        let mut session = *carry.0;
        session.set_store(session.store.clone());
        session.summaries_unread = true;
        session.summaries_ready();
        session
    }

    /// Setup: take the conditions, and make sure ck-mc's view matches the one
    /// the runner applies (after a restart of either side it may not).
    ///
    /// A new session with a head gets its first view right away, before its
    /// first request: nothing is cached yet, so it costs nothing, and the
    /// model sees its memories and docs from the first step.
    ///
    /// Its end is logged with what it cost: a slow first step can wait on
    /// Setup's reads from the runner, and the line that opens Setup says
    /// nothing about them.
    pub async fn setup<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        route: &Route,
        request: &SetupRequest,
        features: Features,
    ) {
        let started = std::time::Instant::now();
        let before = self.runner_reads.counts();
        let late = std::mem::take(&mut self.late_statements);
        self.set_up(client, settings, route, request, features)
            .await;
        let read = self.runner_reads.since(before);
        tracing::info!(
            "ck-mc: session {}: setup done in {} ms: {} transcript reads returned {} entries; applied view read back: {}; {late} notices or rides built before one already taken arrived since the previous Setup",
            self.key.session,
            started.elapsed().as_millis(),
            read.reads,
            read.entries,
            read.read_back()
        );
    }

    /// What [`Session::setup`] does, with every early return.
    pub(super) async fn set_up<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        route: &Route,
        request: &SetupRequest,
        features: Features,
    ) {
        let statement_epoch = request
            .statement_epoch
            .as_deref()
            .map(|epoch| epoch.chars().take(8).collect::<String>())
            .unwrap_or_else(|| "none".into());
        let statement_stamp = request
            .statement_seq
            .map(|stamp| stamp.to_string())
            .unwrap_or_else(|| "none".into());
        tracing::info!(
            "ck-mc: session {}: setup ({}, preset {}, model {}/{}, child harness {}, window {}, reserve {}, applied view {:?}, statement epoch {}, stamp {})",
            self.key.session,
            self.key.harness,
            request.preset,
            request.model.provider,
            request.model.model,
            request.child_harness.as_deref().unwrap_or("none"),
            request.context_window,
            request.output_reserve,
            request.applied_view.as_ref().map(|view| view.version),
            statement_epoch,
            statement_stamp
        );
        // Summaries a resume could not read again are read first; until
        // then the Setup takes nothing (the worker holds it meanwhile).
        if !self.summaries_ready() {
            return;
        }
        self.features = features;
        self.preset = crate::catalog::Preset::parse(&request.preset).expect("validated preset");
        self.tools_only = false;
        self.suspended = false;
        // A new Setup can follow a plan change or a runner restart, so a plan
        // that refused the clock note may hold it now: the next due tool turn
        // tries once more.
        self.clock_note.refused = false;
        self.conditions = conditions_of(request);
        self.limits = crate::reads::Limits::from_setup(request.limits.as_ref());
        // Setup states the session as it is now: its epoch and stamp replace
        // the held ones, even when the stamp is lower than one taken before
        // (a runner restored from a backup). Without them, statements are
        // taken in arrival order again.
        self.statement_seq = request.statement_seq;
        self.statement_epoch = request.statement_epoch.clone();
        self.statement_late = false;
        // Setup is the runner's statement afresh: a floor a refusal showed
        // it contradicting is taken again if this Setup names it.
        self.disproved_floor = None;
        // Setup is where a session without a summarizer tries views again
        // after one was refused for history without part numbers.
        self.numbers_views_held = false;
        // Setup carries no reading, so none is stale. A runner that named
        // views it had already replaced is trusted again: Setup starts its
        // reports afresh.
        self.reading_stale = false;
        self.ignored_reading = None;
        self.prompt_views_untrusted = false;
        self.child_harness = request.child_harness.clone();
        self.view_anchor = request.view_anchor == Some(true);
        self.notice_keep = false;
        self.notice_keep = client.notice_keep(&self.key).await;
        self.project = route.project.clone();
        self.workdir = folder_of(route);
        self.agent_id = route.agent_id.clone();
        self.seq = 0;
        self.note_transcript_growth(request.newest.as_ref());
        // Before anything is offered, settled or read: a transcript that no
        // longer holds the summaries' history holds the session here, with
        // its state as it was.
        let check = self.check_summaries(client).await;
        let forget_from = match check {
            SummaryCheck::Behind { failed } => {
                self.hold_transcript_behind(failed, request.newest.as_ref());
                return;
            }
            // A failed read proves nothing, so a held session stays held.
            SummaryCheck::ReadFailed if self.transcript_behind.is_some() => return,
            SummaryCheck::ReadFailed => None,
            SummaryCheck::Whole { forget_from } => {
                self.release_transcript_hold();
                Some(forget_from)
            }
        };
        self.app_resume_head();
        // The newest view the runner reported applying before this Setup.
        // After a restart ck-mc holds no copy of it, only its version.
        let applied_before = self.newest_applied;
        self.settle_unconfirmed(request.applied_view.as_ref(), &[]);
        // Before anything is offered: a view offered again must meet the
        // floor too.
        self.load_move_floor(client).await;
        self.judge_acceptance_afresh();
        self.offer_unconfirmed_again(client).await;
        let lost = self.runner_lost_view_at_setup(request.applied_view.as_ref(), applied_before);
        let Some(forget_from) = forget_from else {
            self.index_ready = false;
            return;
        };
        if let Some(ordinal) = forget_from {
            self.invalidate_transcript_from(ordinal);
        }
        let force = !self.index_ready || !self.index.entries().is_empty();
        let after = self.index.base().checked_sub(1).filter(|n| *n > 0);
        self.index_ready = self
            .read_until_from(client, request.newest.as_ref(), force, after)
            .await;
        if !self.index_ready {
            return;
        }
        // The floor names an entry, so it is taken once the read holds it.
        self.take_signed_floor();
        // A process can stop after the runner changed an older tool result but
        // before the background dirty mark was committed. On Setup, reconcile
        // the raw entries loaded from the summary cut through the newest row,
        // as well as the durable archive boundary. Nothing before that cut can
        // still carry a mutable raw tool result.
        self.search_reconcile_from = Some(self.index.base());
        // After the read, so the cut message of the view the runner applies
        // is in the index.
        if self.runner_differs(request.applied_view.as_ref()) {
            self.adopt_runner_view(client).await;
        }
        self.settle_spent_reading(request.applied_view.as_ref());
        if let Some(view) = &self.latest {
            self.view_validation.prime(self.index.entries(), view);
        }
        self.app_projection.head_read.ready = !self.latest_unknown;
        // An empty transcript keeps its own rule: a session with a head and
        // no view of ck-mc's gets its first view now.
        if request.newest.is_none() {
            if self.features.summarizer && self.latest.is_none() {
                let (view, _) = self.build_now(client, settings).await;
                if let Some(view) = view {
                    self.publish(client, view).await;
                }
            }
        } else if let Some(current) = lost {
            self.offer_at_setup(client, settings, request.applied_view.as_ref(), current)
                .await;
        }
    }

    /// Whether Setup finds that the runner lost ck-mc's view, once Setup has
    /// settled the views and offered a waiting one again. Only a session whose
    /// host may hold a compaction marker counts (`marker_possible`): one that
    /// never had a view of ck-mc's applied, or installed by a move, renders
    /// unreduced and keeps sending notices, so its summaries wait for the
    /// next permitted rebuild, and Setup doesn't rewrite the request bytes the
    /// provider has cached for it. Such a runner lost the view when it applies
    /// none, whatever ck-mc's own record says, or one older than ck-mc's
    /// newest view that it applied or was handed. `applied_before` is the
    /// newest view the runner reported applying before this Setup, which is
    /// all ck-mc knows of its confirmed view after a restart. A view the
    /// runner took on this Setup's offer again counts as held, and so does one
    /// whose offer again is still waiting for an answer or for the runner to
    /// place its cut. Returns ck-mc's current view's version (0 for none) when
    /// the runner lost it.
    fn runner_lost_view_at_setup(
        &self,
        applied: Option<&AppliedView>,
        applied_before: u64,
    ) -> Option<u64> {
        if !self.marker_possible
            || self.reoffer_pending
            || self
                .unconfirmed
                .last()
                .is_some_and(|pending| pending.accepted)
        {
            return None;
        }
        let current = match &self.latest {
            Some(view) => view.version,
            None if self.latest_unknown => applied_before,
            None => 0,
        };
        applied
            .is_none_or(|applied| applied.version < current)
            .then_some(current)
    }

    /// Setup found that the runner lost ck-mc's view (see
    /// [`Session::runner_lost_view_at_setup`]), and it has read the transcript
    /// and taken the view the runner applies. A session past its host's
    /// compaction marker (written at an applied view's cut, after which the
    /// host no longer loads the messages before it), or moved in from
    /// another host, takes no step until a view applies, so no notice may
    /// come to offer one: Setup builds and offers it itself, whatever the
    /// usage, and whatever the bound on such offers says (see
    /// `lost_view_offers`). When the runner applies none, a refused view
    /// stays due on later notices, within that bound. Only a session with a
    /// summarizer renders a head, and only one with summaries or a cut has
    /// history to serve. When the runner applies a view, one another
    /// provider owns is left to it, and none is built while ck-mc couldn't
    /// read the runner's view back.
    async fn offer_at_setup<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        applied: Option<&AppliedView>,
        current: u64,
    ) {
        if !self.features.summarizer || (self.summaries.is_empty() && self.cut.is_none()) {
            return;
        }
        match applied {
            // The Setup states that the runner applies no view, so a view
            // that couldn't be read back is none.
            None => {
                if self.latest_unknown {
                    self.latest_unknown = false;
                    self.latest = None;
                }
                self.lost_view_due = true;
            }
            Some(_)
                if self.latest_unknown || (self.latest.is_none() && self.newest_applied != 0) =>
            {
                return;
            }
            Some(_) => {}
        }
        let applying = applied.map_or_else(
            || "no view".to_owned(),
            |view| format!("view {}", view.version),
        );
        let newest = match current {
            0 => "none".to_owned(),
            version => format!("view {version}"),
        };
        tracing::info!(
            "ck-mc: session {}: Setup found the runner applying {applying} where its host may hold a compaction marker (ck-mc's newest view: {newest}); the history head is rebuilt and offered now",
            self.key.session
        );
        let (view, _) = self.build_now(client, settings).await;
        if let Some(view) = view {
            self.record_lost_view_offer(&view);
            self.publish(client, view).await;
        }
    }
}
