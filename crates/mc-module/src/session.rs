//! One session's state, and everything that happens to it. A session's jobs
//! run one at a time on its own worker ([`crate::module`]), so nothing here
//! needs a lock.

use std::collections::BTreeSet;
use std::sync::Arc;

use cortexkit_role_compaction::notice::{Conditions, Event, NoticeRequest};
use cortexkit_role_compaction::part::PartBody;
use cortexkit_role_compaction::read::{Cursor, Detail, ReadRequest, Select, SessionRef};
use cortexkit_role_compaction::ride::{RideCause, RideRequest};
use cortexkit_role_compaction::setup::SetupRequest;
use cortexkit_role_compaction::view::{
    AppliedView, ApplyViewAnswer, ApplyViewRequest, EditOp, View, ViewRefusal, MAX_VIEW_BYTES,
};
use cortexkit_role_llm_runner::delivery_order::{DeliveryOrder, Mode, TemplateUse};
use cortexkit_role_llm_runner::send::SendRequest;
use serde_json::Value;

use crate::client::RunnerClient;
use crate::context_db::{ContextDb, StoredCompartment, StoredMemory};
use crate::index::{Extend, Index};
use crate::lanes;
use crate::pass::{self, Settings};
use crate::preset::Features;
use crate::reduce;
use crate::route::{Project, Route};
use crate::summary::head::{self, Baseline};
use crate::summary::run;
use crate::summary::trigger;
use crate::summary::two_pass::turn_one;
use crate::tokens;
use crate::view_builder;

/// How many bytes one catch-up read asks for at most.
const READ_PAGE_BYTES: u64 = 1 << 20;

pub struct Session {
    key: SessionRef,
    features: Features,
    conditions: Conditions,
    index: Index,
    /// The newest view the runner accepted (or took with a ride answer). The
    /// next view carries its edits forward.
    latest: Option<View>,
    /// The highest version ck-mc has built for the session, accepted or not,
    /// so a version number is never used twice.
    version: u64,
    /// Parts the model asked to drop, held for the next view.
    queued: BTreeSet<(String, String)>,
    /// The age sweep's bookmark from the previous pass with permission to
    /// rebuild: tool outputs at or below it were already far behind then.
    reclaim_bookmark: u64,
    /// An emergency batch landed during this stay in the force band. Another
    /// one waits until usage leaves the band, or a pass rewrites anyway, so
    /// the band never trickles one rewrite per pass.
    emergency_latched: bool,
    /// Set when the pass being built selected an emergency batch; it latches
    /// only once the runner takes the view.
    next_latch: bool,
    /// Parts whose edits once made a view fail ck-mc's own checks. Automatic
    /// lanes leave them alone, so the same failing view is not rebuilt on
    /// every pass.
    failed_parts: BTreeSet<lanes::PartKey>,
    /// The model was asked to call `ctx_keep` during this stay over the
    /// execute threshold; it is not asked again until usage falls below it.
    keep_requested: bool,
    /// What a `ctx_keep` call asked to keep. The next notice builds the view
    /// that keeps only that, whatever the usage: the model asked for it.
    pending_keep: Option<BTreeSet<lanes::PartKey>>,
    /// The highest notice number handled.
    seq: u64,
    /// The session's summaries, oldest first.
    summaries: Vec<StoredCompartment>,
    /// What the head's baseline (`m[0]`, see the crate docs) holds; `None`
    /// until the first summary reaches a view.
    baseline: Option<Baseline>,
    /// A summarizer run is in progress.
    summarizing: bool,
    /// The next view re-renders the baseline (`m[0]`), because the
    /// provider cache is lost anyway.
    fold_due: bool,
    /// Where summaries and memories are kept; absent only in tests.
    db: Option<Arc<ContextDb>>,
    project: Option<Project>,
    /// The scope's folder, which may be stamped without a project id (see
    /// [`Route::workdir`]): configuration and the summarizer's child sessions
    /// use it even when the session has no project.
    workdir: Option<String>,
    /// The baseline a view being published was built on; it replaces
    /// `baseline` once the runner takes the view.
    next_baseline: Option<Baseline>,
    /// How far each compressed text part is compressed, as the applied view
    /// shows it.
    caveman: lanes::CavemanState,
    /// The caveman state of the view being handed over, which counts once
    /// the runner takes it.
    next_caveman: Option<lanes::CavemanState>,
    /// The parts the view being handed over drops. Queued drops among them
    /// are forgotten once the runner takes it; a refused view leaves them
    /// queued for the next one.
    next_covered: Vec<lanes::PartKey>,
    /// Queued drops a refused view already carried once. A second refusal
    /// carrying one forgets it, so a drop the runner keeps refusing cannot
    /// make every later pass build a view it refuses.
    refused_once: BTreeSet<lanes::PartKey>,
    /// A revert removed summaries the head shows. The next notice rebuilds
    /// the head whatever the usage: the model must not keep seeing history
    /// that was undone.
    head_stale: bool,
    /// The `ctx_reduce` reminders' cadence.
    nudges: crate::nudges::State,
    /// The ordinal of the last message the applied view cuts. The index
    /// starts there: what comes before is replaced by summaries.
    cut: Option<u64>,
    /// Messages a person wrote that the index no longer holds, so the
    /// reminders' turn count keeps counting them.
    pruned_turns: u64,
    /// The session never had a Setup: Magic Context serves its tools only
    /// ([`Session::tools_only`]).
    tools_only: bool,
    /// After a summarizer run that published nothing: the newest message at
    /// that moment, and whether the force band's one retry was used. The
    /// same history is not run again until a newer message arrives
    /// ([`Session::waits_for_new_history`]).
    no_progress: Option<(String, bool)>,
    /// The newest prompt a run has already summarized past once at the
    /// execute threshold ([`Session::summary_due`]).
    floor_lifted_for: Option<String>,
    /// How much history the summarizer may still read in the drain quota's
    /// current ten-minute window.
    drain: crate::summary::drain::Drain,
    /// The raw tokens the run in progress reserved.
    reservation: Option<crate::summary::drain::Reservation>,
    /// The output text of tool results with answered images, read in full
    /// once, so the answered-images lane can keep the text and mark each
    /// removed image ([`lanes::image_results`]).
    image_outputs: std::collections::BTreeMap<lanes::PartKey, String>,
    /// The session's memory context, fixed at its first Setup or first
    /// memory write (spec 3c, ML1), and what its writes record from it.
    memory_context: Option<crate::memory_profile::MemoryContext>,
    authority: Option<crate::memory_levels::Authority>,
    /// Views the runner took but has not yet confirmed it applies, oldest
    /// first, each with the state its acceptance replaced (spec 4, WK3).
    unconfirmed: Vec<Unconfirmed>,
    /// Where the session's state is saved before a view leaves ck-mc, so a
    /// crash never leaves the runner holding a view ck-mc has forgotten.
    store: Option<Arc<crate::store::Store>>,
}

/// A view the runner took (an `apply_view` it accepted, or a ride's answer)
/// and has not yet reported applying. The runner can still refuse it at a
/// step boundary (a `view_refused` event), and then ck-mc puts back what
/// accepting it changed: the queued drops it carried, the emergency latch,
/// the baseline, the caveman levels and the cut.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Unconfirmed {
    pub view: View,
    /// The queued drops the view carried.
    covered: Vec<lanes::PartKey>,
    before: Before,
}

/// The state a view's acceptance replaced.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct Before {
    latest: Option<View>,
    queued: BTreeSet<lanes::PartKey>,
    refused_once: BTreeSet<lanes::PartKey>,
    emergency_latched: bool,
    baseline: Option<Baseline>,
    fold_due: bool,
    caveman: lanes::CavemanState,
    cut: Option<u64>,
    pruned_turns: u64,
}

/// Whether the runner reports applying `view`.
fn same(applied: &AppliedView, view: &View) -> bool {
    applied.version == view.version && applied.checksum == view.checksum
}

impl Session {
    pub fn new(
        route: &Route,
        request: &SetupRequest,
        features: Features,
        db: Option<Arc<ContextDb>>,
    ) -> Self {
        Self {
            db,
            project: route.project.clone(),
            workdir: folder_of(route),
            key: route.session.clone(),
            features,
            conditions: conditions_of(request),
            index: Index::default(),
            latest: None,
            version: 0,
            queued: BTreeSet::new(),
            reclaim_bookmark: 0,
            emergency_latched: false,
            next_latch: false,
            failed_parts: BTreeSet::new(),
            keep_requested: false,
            pending_keep: None,
            seq: 0,
            summaries: Vec::new(),
            baseline: None,
            next_baseline: None,
            caveman: lanes::CavemanState::default(),
            next_caveman: None,
            next_covered: Vec::new(),
            refused_once: BTreeSet::new(),
            summarizing: false,
            fold_due: false,
            head_stale: false,
            nudges: crate::nudges::State::default(),
            cut: None,
            pruned_turns: 0,
            tools_only: false,
            no_progress: None,
            floor_lifted_for: None,
            drain: Default::default(),
            reservation: None,
            image_outputs: std::collections::BTreeMap::new(),
            memory_context: None,
            authority: None,
            unconfirmed: Vec::new(),
            store: None,
        }
    }

    /// Save the session's state here before each view it hands over.
    pub fn set_store(&mut self, store: Option<Arc<crate::store::Store>>) {
        self.store = store;
    }

    /// Whether the session's memory context is known yet.
    pub fn has_memory_context(&self) -> bool {
        self.memory_context.is_some()
    }

    /// Take the session's memory context. It never changes afterwards.
    pub fn set_memory_context(&mut self, context: crate::memory_profile::MemoryContext) {
        if self.memory_context.is_none() {
            self.authority = crate::memory_levels::Authority::from_context(&context);
            self.memory_context = Some(context);
        }
    }

    /// Whether the summarizer may read and admit memories: configured, and
    /// the session's memory profile was not refused. A refused profile keeps
    /// existing memories in the head (spec 3c, ML1.6).
    fn memory_admissions(&self, settings: &Settings) -> bool {
        settings.memory_enabled
            && !self.memory_context.as_ref().is_some_and(|context| {
                matches!(
                    context.profile.state.as_str(),
                    "unresolved" | "conflict" | "blocked" | "unavailable"
                )
            })
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

    /// Whether Magic Context compacts this session (it had a Setup), rather
    /// than only serving its tools.
    pub fn compacting(&self) -> bool {
        !self.tools_only
    }

    pub fn key(&self) -> &SessionRef {
        &self.key
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
        crate::store::Durable {
            version: self.version,
            queued: self.queued.clone(),
            reclaim_bookmark: self.reclaim_bookmark,
            emergency_latched: self.emergency_latched,
            keep_requested: self.keep_requested,
            baseline: self.baseline.clone(),
            nudges: self.nudges.clone(),
            cut: self.cut,
            pruned_turns: self.pruned_turns,
            caveman: self.caveman.clone(),
            drain: self.drain.clone(),
            no_progress: self.no_progress.clone(),
            floor_lifted_for: self.floor_lifted_for.clone(),
            unconfirmed: self.unconfirmed.clone(),
        }
    }

    /// Take back what a previous ck-mc process saved for the session.
    pub fn restore(&mut self, durable: crate::store::Durable) {
        self.version = durable.version;
        self.queued = durable.queued;
        self.reclaim_bookmark = durable.reclaim_bookmark;
        self.emergency_latched = durable.emergency_latched;
        self.keep_requested = durable.keep_requested;
        self.baseline = durable.baseline;
        self.nudges = durable.nudges;
        self.cut = durable.cut;
        self.pruned_turns = durable.pruned_turns;
        self.caveman = durable.caveman;
        self.drain = durable.drain;
        self.no_progress = durable.no_progress;
        self.floor_lifted_for = durable.floor_lifted_for;
        self.unconfirmed = durable.unconfirmed;
        // A view handed over before the restart is the one ck-mc expects
        // the runner to show; Setup settles it.
        self.latest = self.unconfirmed.last().map(|pending| pending.view.clone());
        // The first read after a restart starts at the cut: nothing before
        // it is visible to the model.
        self.index = Index::starting_at(durable.cut.unwrap_or(1));
    }

    /// Load the summaries `context.db` already holds for the session, such as
    /// those of a session moved in from a standalone host.
    pub fn load_summaries(&mut self) {
        let Some(db) = &self.db else {
            return;
        };
        match db.compartments(&self.key.harness, &self.key.session) {
            Ok(summaries) => self.summaries = summaries,
            Err(error) => eprintln!(
                "ck-mc: session {}: loading summaries failed: {error}",
                self.key.session
            ),
        }
    }

    /// Setup: take the conditions, and make sure ck-mc's view matches the one
    /// the runner applies (after a restart of either side it may not).
    ///
    /// A new session with a head gets its first view right away, before its
    /// first request: nothing is cached yet, so it costs nothing, and the
    /// model sees its memories and docs from the first step.
    pub async fn setup<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        route: &Route,
        request: &SetupRequest,
        features: Features,
    ) {
        self.features = features;
        self.tools_only = false;
        self.conditions = conditions_of(request);
        self.project = route.project.clone();
        self.workdir = folder_of(route);
        self.seq = 0;
        self.settle_unconfirmed(request.applied_view.as_ref(), &[]);
        self.offer_unconfirmed_again(client).await;
        self.sync(client, request.newest.as_ref()).await;
        // After the read, so the cut message of the view the runner applies
        // is in the index (spec 4, ST2).
        if self.runner_differs(request.applied_view.as_ref()) {
            self.adopt_runner_view(client).await;
        }
        if self.features.summarizer && self.latest.is_none() && request.newest.is_none() {
            let (view, _) = self.build_now(client, settings).await;
            if let Some(view) = view {
                self.publish(client, view).await;
            }
        }
    }

    /// Handle a notice. Returns a summarizer run for the worker to start, when
    /// one is due. After the pass, the `ctx_reduce` reminders read what the
    /// model now sees.
    pub async fn notice<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        notice: NoticeRequest,
    ) -> Option<run::Request> {
        // Not newer than the last notice handled since Setup (compaction contract N5). Setup sets
        // the count to 0 and a runner's first notice after it is 1, so this
        // also ignores a notice numbered 0.
        if notice.seq <= self.seq {
            return None;
        }
        let version = self.latest.as_ref().map(|view| view.version);
        let cut = self.cut_ordinal();
        let summary = self.handle_notice(client, settings, notice).await;
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
    ) -> Option<run::Request> {
        self.seq = notice.seq;
        self.conditions = notice.conditions.clone();
        // What the runner says about the views it took comes first: a
        // rollback restores the state before the events below change it.
        let refused: Vec<u64> = notice
            .events
            .iter()
            .filter_map(|event| match event {
                Event::ViewRefused { version, .. } => Some(*version),
                _ => None,
            })
            .collect();
        self.settle_unconfirmed(notice.applied_view.as_ref(), &refused);
        for event in &notice.events {
            match event {
                Event::TranscriptChanged { from_ordinal } => {
                    self.index.truncate(*from_ordinal);
                    self.forget_summaries_from(*from_ordinal);
                    if self.cut.is_some_and(|cut| *from_ordinal <= cut) {
                        // The undo reached the cut message or before it, and
                        // the summaries of what it removed are gone. The next
                        // view cuts at the last summary left; the index is
                        // read again from there.
                        self.cut = self.summarized_through();
                        self.index = Index::starting_at(self.cut.unwrap_or(1));
                    }
                    if let Some(db) = &self.db {
                        let (harness, session) = (&self.key.harness, &self.key.session);
                        if let Err(error) = db.with_connection(|conn| {
                            crate::search::messages::forget_from(
                                conn,
                                harness,
                                session,
                                *from_ordinal,
                            )
                        }) {
                            eprintln!(
                                "ck-mc: session {session}: search index revert failed: {error}"
                            );
                        }
                    }
                }
                Event::ViewRefused { .. } => {}
                Event::MarkerWritten { .. } => {}
                // An event the contract may add later: its reach is unknown,
                // so the index is read again from the cut, the oldest message
                // the model still sees (compaction contract W1.5).
                other => {
                    eprintln!(
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
        // No newest entry: the transcript is empty, and the read empties the
        // index.
        if self.index.extend(notice.entries) != Extend::Continued
            || !self.index.ends_at(notice.newest.as_ref())
        {
            self.sync(client, notice.newest.as_ref()).await;
        } else if let Some(newest) = notice.newest.as_ref().filter(|_| omitted) {
            self.sync_from_changeable(client, newest).await;
        }
        // A view the runner applies that ck-mc does not expect (it lost one,
        // or restored an older one) is taken as ck-mc's own. After the read,
        // so the view's cut message is in the index.
        if self.runner_differs(notice.applied_view.as_ref()) {
            self.adopt_runner_view(client).await;
        }
        self.forget_missing();
        self.update_search_index();
        if !pass::in_force_band(&self.conditions, settings) {
            self.emergency_latched = false;
        }
        let execute = pass::at_execute(&self.conditions, settings);
        if !execute {
            self.keep_requested = false;
        }
        if let Some(kept) = self.pending_keep.take() {
            let (view, _) = self.build(settings, None, false, Some(&kept));
            if let Some(view) = view {
                self.publish(client, view).await;
            }
            self.keep_requested = false;
            return None;
        }
        let summary = self.summary_due(settings);
        let force = pass::in_force_band(&self.conditions, settings);
        if self.head_shape_changed(settings) {
            self.fold_due = true;
            self.head_stale = true;
        }
        if std::mem::take(&mut self.head_stale) {
            let (view, _) = self.build_now(client, settings).await;
            if let Some(view) = view {
                self.publish(client, view).await;
            }
            return summary;
        }
        if execute
            && (force || !self.summary_on_its_way())
            && !pass::signed_thinking_hold(self.index.entries(), &self.conditions, settings)
        {
            let (view, freed) = self.build_now(client, settings).await;
            if let Some(view) = view {
                self.publish(client, view).await;
            }
            self.ask_for_keep_if_short(client, settings, freed).await;
        }
        summary
    }

    /// A summarizer run to start now, if one is due: the session has a
    /// summarizer, none is running, and the history it may read is worth a
    /// run at this usage.
    fn summary_due(&mut self, settings: &Settings) -> Option<run::Request> {
        if !self.features.summarizer || self.summarizing {
            return None;
        }
        let memory_enabled = self.memory_admissions(settings) && self.project.is_some();
        let window = self.conditions.context_window;
        let threshold = settings.execute_threshold_percentage;
        let usage = pass::usage(&self.conditions).unwrap_or(0.0) * 100.0;
        let force = pass::in_force_band(&self.conditions, settings);
        let from = self.summarized_through().map_or(1, |ordinal| ordinal + 1);
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
        if self.drain.exhausted(&quota) {
            return None;
        }
        // The scan measures the lines in the summarizer's own tokens, scaled
        // to the model's by the larger of its prose and tool ratios.
        let model = &self.conditions.model;
        let calibration = crate::calibration::DecisionCalibration::for_model(Some(&format!(
            "{}/{}",
            model.provider, model.model
        )));
        let ratio = calibration
            .prose_ratio
            .max(calibration.tools_ratio)
            .max(1.0);
        let scan_lines = (trigger::scan_budget(budget) as f64 / ratio).floor() as u64;
        let bounded = |tail_tokens: u64, lift: bool| {
            let until = trigger::tail_start(entries, entry_tokens, from, tail_tokens, lift);
            trigger::cap_run(entries, entry_tokens, from, until, cap)
        };
        let scan_at = |until: u64| -> Option<trigger::Scan> {
            let low = entries.partition_point(|entry| entry.ordinal < from);
            let high = entries.partition_point(|entry| entry.ordinal < until);
            let readable = &entries[low..high.max(low)];
            let chunk = crate::summary::chunk::build(readable, scan_lines)?;
            Some(trigger::Scan {
                tokens: (chunk.token_estimate as f64 * ratio).ceil() as u64,
                has_more: chunk.has_more,
                commit_clusters: chunk.commit_clusters,
                messages: chunk.messages,
                raw_tokens: readable.iter().map(entry_tokens).sum(),
            })
        };
        let pressure = trigger::Pressure {
            usage,
            threshold,
            force,
            // Drops land only on a pass allowed to rebuild. A head whose
            // summary is still to come is allowed one in the force band, so
            // the usage after its drops counts there.
            after_drops: force
                .then(|| self.usage_after_drops(settings, usage))
                .flatten(),
        };
        let decide = |until: u64| {
            trigger::decide(
                &pressure,
                scan_at(until).as_ref(),
                budget,
                settings.commit_clusters,
            )
        };
        let mut until = bounded(tail, force);
        let mut decision = decide(until);
        // The prompt this run summarizes past, once it is admitted.
        let mut lifting = None;
        if decision.is_none() && force {
            // Nothing to read in the force band: the protected tail shrinks
            // to a half, or a quarter from 95% (the plugin's emergency tail
            // scale).
            let scale = if usage >= 95.0 { 0.25 } else { 0.5 };
            until = bounded((tail as f64 * scale) as u64, true);
            decision = decide(until);
        }
        if decision.is_none() {
            // At the threshold, a long turn's history after the person's
            // newest prompt cannot be summarized while that prompt stays raw.
            // The plugin lets one run summarize past it, once per prompt
            // (`compartment-trigger.ts`, the live-prompt floor lift).
            let prompt = entries
                .iter()
                .rev()
                .find(|entry| trigger::is_meaningful_user(entry))
                .map(|entry| entry.mid.clone());
            let lifted = bounded(tail, true);
            if usage < threshold || prompt.is_none() || prompt == self.floor_lifted_for {
                return None;
            }
            decision = decide(lifted);
            decision?;
            until = lifted;
            lifting = prompt;
        }
        if self.waits_for_new_history(force) {
            return None;
        }
        let requested: u64 = self
            .index
            .entries()
            .iter()
            .filter(|entry| entry.ordinal >= from && entry.ordinal < until)
            .map(entry_tokens)
            .sum();
        let Some(reservation) = self.drain.reserve(&quota, requested) else {
            eprintln!(
                "ck-mc: session {}: summary skipped: drain budget spent ({} tokens this window)",
                self.key.session, self.drain.spent
            );
            return None;
        };
        self.reservation = Some(reservation);
        self.summarizing = true;
        // The lift is spent only by a run that actually starts.
        if lifting.is_some() {
            self.floor_lifted_for = lifting;
        }
        Some(run::Request {
            session: self.key.clone(),
            from,
            until,
            project_root: self.workdir.clone(),
            project: self.project.as_ref().map(|project| project.id.clone()),
            two_pass: settings.turn_two && !settings.editor_pass,
            summaries: self.summaries.clone(),
            language: settings.language.clone(),
            memories: self.historian_memories(memory_enabled),
            memory_enabled,
            auto_promote: settings.auto_promote,
            emergency: force,
        })
    }

    /// The session's clock for the drain quota: when the runner wrote the
    /// newest message, which a notice follows at once. Decisions then follow
    /// the transcript alone, as every other decision here does; the wall
    /// clock is used only before the first message.
    fn clock(&self) -> i64 {
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
    fn usage_after_drops(&self, settings: &Settings, usage: f64) -> Option<f64> {
        let edited = lanes::Edited::of(self.latest.as_ref(), &self.index, self.cut);
        let context = lanes::Context {
            index: &self.index,
            edited: &edited,
            protected_tools: &settings.protected_tools,
            keep_first_message: self.features.keep_first_message,
        };
        let mut wanted: Vec<(lanes::PartKey, lanes::Shape)> = self
            .queued
            .iter()
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
            .map(|(_, part)| tokens::part(part))
            .sum();
        (freed > 0 && total > 0).then(|| usage * (1.0 - (freed as f64 / total as f64).min(1.0)))
    }

    /// Whether a run would read the same history a run before it failed to
    /// summarize, as the plugin's `historian-history-wait.ts`: it waits for a
    /// newer message, so a failing summary does not pay for the same input on
    /// every pass. In the force band it may try once more.
    fn waits_for_new_history(&mut self, force: bool) -> bool {
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
        let force = pass::in_force_band(&self.conditions, settings);
        let retried = match &self.no_progress {
            Some((previous, retried)) if *previous == newest => *retried || force,
            _ => force,
        };
        self.no_progress = Some((newest, retried));
    }

    /// The project's memories for the summarizer's `<project-memory>` block;
    /// none with memory off.
    fn historian_memories(&self, memory_enabled: bool) -> Vec<StoredMemory> {
        let (Some(db), Some(project), true) = (&self.db, &self.project, memory_enabled) else {
            return Vec::new();
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as i64);
        db.project_memories(&project.id, now).unwrap_or_default()
    }

    /// After a revert removed messages from `ordinal` on, forget the summaries
    /// that cover any of them, as the standalone plugin does when its host
    /// reverts. If the history head showed one of them, it is rendered again
    /// from the summaries that remain.
    fn forget_summaries_from(&mut self, ordinal: u64) {
        let Some(first) = self
            .summaries
            .iter()
            .position(|summary| summary.end_message as u64 >= ordinal)
        else {
            return;
        };
        let sequence = self.summaries[first].sequence;
        if let Some(db) = &self.db {
            if let Err(error) =
                db.delete_compartments_from(&self.key.harness, &self.key.session, sequence)
            {
                eprintln!(
                    "ck-mc: session {}: deleting reverted summaries failed: {error}",
                    self.key.session
                );
            }
        }
        self.summaries.truncate(first);
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
        self.head_stale = self
            .latest
            .as_ref()
            .is_some_and(|view| view.edits.iter().any(|edit| head::is_head(&edit.op)));
    }

    /// The id of the last message a summary covers.
    pub fn last_summary_end(&self) -> Option<String> {
        self.summaries
            .last()
            .map(|summary| summary.end_message_id.clone())
    }

    /// The last ordinal a summary covers. Summaries name messages by
    /// ordinal, which counts from 1.
    fn summarized_through(&self) -> Option<u64> {
        self.summaries
            .last()
            .map(|summary| summary.end_message as u64)
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
        result: Result<Option<run::Summarized>, String>,
        now_ms: i64,
    ) -> Option<run::Continuation> {
        self.summarizing = false;
        let reservation = self.reservation.take();
        let (validated, publication, continuation) = match result {
            Ok(Some(summarized)) => (
                summarized.validated,
                summarized.publication,
                summarized.continuation,
            ),
            Ok(None) => {
                if let Some(reservation) = reservation {
                    self.drain.release(reservation);
                }
                self.record_no_progress(settings);
                return None;
            }
            // The summarizer failed: the reservation stays spent, so a broken
            // summarizer does not run again on every pass. The wait for new
            // history is only for a run that published nothing (the plugin's
            // `historian-history-wait.ts`): a provider that recovers may run
            // again on the same history while the quota lasts.
            Err(error) => {
                eprintln!(
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
        // On the two-pass lane the facts are candidates for the second
        // turn, stored with the publication; they never become memories here.
        let two_pass = publication
            .as_ref()
            .is_some_and(|publication| publication.send.lane == turn_one::Lane::Enabled);
        if let Some(db) = &self.db {
            // Facts become memories of the session's project, with memory and
            // auto-promotion on; the validator already left them out otherwise.
            let facts: Vec<(String, String)> = validated
                .facts
                .iter()
                .map(|fact| (fact.category.clone(), fact.content.clone()))
                .collect();
            let promote = self
                .project
                .as_ref()
                .filter(|_| {
                    !two_pass
                        && self.memory_admissions(settings)
                        && settings.auto_promote
                        && !facts.is_empty()
                })
                .map(|project| crate::context_db::Promotion {
                    project: project.id.as_str(),
                    facts: facts.as_slice(),
                    authority: self.authority.as_ref(),
                });
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
            let recall = crate::context_db::Recall {
                events: validated.events.clone(),
                primer,
            };
            if let Err(error) = db.publish_summaries(
                &self.key.harness,
                &self.key.session,
                &validated.compartments,
                promote,
                publication.as_ref(),
                &recall,
                now_ms,
            ) {
                eprintln!(
                    "ck-mc: session {}: storing summaries failed: {error}",
                    self.key.session
                );
                self.record_no_progress(settings);
                return None;
            }
        }
        self.no_progress = None;
        self.summaries
            .extend(validated.compartments.iter().map(StoredCompartment::from));
        // The signed-thinking hold applies here as on a notice: the summary
        // lands on the next pass the hold lets through.
        if pass::at_execute(&self.conditions, settings)
            && !pass::signed_thinking_hold(self.index.entries(), &self.conditions, settings)
        {
            let (view, _) = self.build_now(client, settings).await;
            if let Some(view) = view {
                self.publish(client, view).await;
            }
        }
        continuation.filter(|_| two_pass && self.db.is_some())
    }

    /// The second turn a two-pass summary's first turn calls for.
    pub fn turn_two_job(
        &self,
        settings: &Settings,
        continuation: run::Continuation,
    ) -> Option<crate::summary::two_pass::turn_two::Job> {
        Some(crate::summary::two_pass::turn_two::Job {
            owner: self.key.clone(),
            project: self.project.as_ref()?.id.clone(),
            project_root: self.workdir.clone(),
            continuation,
            memory_enabled: self.memory_admissions(settings),
            auto_promote: settings.auto_promote,
            embedding: settings.embedding.clone(),
            authority: self.authority.clone(),
        })
    }

    /// The ordinal the latest view's cut reaches: messages up to it are
    /// replaced by the history head.
    fn cut_ordinal(&self) -> Option<u64> {
        self.cut
    }

    /// Take `view`'s cut as the applied one, and forget the index before it.
    /// A cut message the index does not hold (a view adopted after a restart)
    /// leaves the known cut as it is.
    fn apply_cut(&mut self, view: &View) {
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
        self.cut = Some(ordinal);
        let gone = self.index.prune_before(ordinal);
        self.pruned_turns += crate::nudges::person_turns(&gone);
    }

    /// Send the `ctx_reduce` reminders this pass calls for (see
    /// [`crate::nudges`]), measured on what the model sees now.
    async fn remind<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        rebuilt: bool,
        cut_moved: bool,
    ) {
        if self.index.entries().is_empty() {
            return;
        }
        let edited = lanes::Edited::of(self.latest.as_ref(), &self.index, None);
        let context = lanes::Context {
            index: &self.index,
            edited: &edited,
            protected_tools: &settings.protected_tools,
            keep_first_message: self.features.keep_first_message,
        };
        let floor = settings.protected_tokens.unwrap_or_else(|| {
            lanes::default_protected_tokens(pass::usable_window(&self.conditions))
        });
        let protected_from = lanes::protected_cutoff(&context, floor);
        let measurement = crate::nudges::measure(&context, protected_from, &self.queued);
        let turns = self.pruned_turns + crate::nudges::person_turns(self.index.entries());
        let reminders = self.nudges.decide(&measurement, rebuilt, turns, cut_moved);
        let sends = [
            (
                reminders.tool_result,
                crate::nudges::REMINDER_KIND,
                Mode::ToolResult,
            ),
            (reminders.ceiling, crate::nudges::CEILING_KIND, Mode::Steer),
        ];
        for (template, kind, mode) in sends {
            let Some(template) = template else {
                continue;
            };
            let request = reminder(format!("{kind}:{}", self.seq), template, kind, mode);
            if let Err(error) = client.send(&self.key, request).await {
                eprintln!(
                    "ck-mc: session {}: session.send failed: {error:?}",
                    self.key.session
                );
            }
        }
    }

    /// After a pass at the execute threshold, a session with `ctx_keep` whose
    /// lanes freed (or lined up) less than `keep_min_recovery_percentage` of
    /// the usable window is asked, once per stay over the threshold, to call `ctx_keep`.
    /// The request goes as a notice message: the model has to act on it, and
    /// no tool result may come before the context runs out.
    async fn ask_for_keep_if_short<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        freed: u64,
    ) {
        let usable = pass::usable_window(&self.conditions);
        // A setting of 100 asks on every such pass.
        let every_pass = settings.keep_min_recovery_percentage >= 100.0;
        if !self.features.ctx_keep
            || (self.keep_requested && !every_pass)
            || usable == 0
            || freed as f64 >= usable as f64 * settings.keep_min_recovery_percentage / 100.0
        {
            return;
        }
        let usage = pass::usage(&self.conditions).unwrap_or(0.0) * 100.0;
        // One request per stay over the threshold, so the view version that
        // crossed it names it.
        let request = reminder(
            format!("{KEEP_KIND}:{}", self.version),
            crate::nudges::keep_request(usage, freed),
            KEEP_KIND,
            Mode::Steer,
        );
        match client.send(&self.key, request).await {
            Ok(_) => self.keep_requested = true,
            Err(error) => eprintln!(
                "ck-mc: session {}: session.send failed: {error:?}",
                self.key.session
            ),
        }
    }

    /// A ride: the runner is about to send a request that rewrites the cache
    /// anyway, or would not fit. Everything held lands now.
    pub fn ride(&mut self, settings: &Settings, ride: &RideRequest) -> Option<View> {
        self.conditions = ride.conditions.clone();
        self.settle_unconfirmed(ride.applied_view.as_ref(), &[]);
        let over_limit = ride
            .has(RideCause::OverLimit)
            .then_some(ride.request_tokens.unwrap_or(0));
        // Any other cause loses the cache, so the head folds for free. So
        // does a settings change `m[0]` depends on, as on a notice. A
        // `ctx_keep` waiting for the next notice lands in this rewrite.
        let cache_lost = ride.cache_lost();
        if cache_lost || self.head_shape_changed(settings) {
            self.fold_due = true;
        }
        let kept = self.pending_keep.take();
        let view = self
            .build(settings, over_limit, cache_lost, kept.as_ref())
            .0?;
        // The size limit holds for a view in a ride's answer as for a pushed
        // one (compaction contract V5); an oversized one is answered as nothing.
        if self.refuse_oversized(&view) {
            return None;
        }
        self.accept(view.clone());
        Some(view)
    }

    /// A `ctx_*` tool call.
    pub async fn tool<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        name: &str,
        input: &Value,
    ) -> Result<String, String> {
        match name {
            // The tools that act on the transcript need a session Magic Context
            // compacts; the catalog never offers them to any other.
            "ctx_reduce" | "ctx_expand" | "ctx_keep" if self.tools_only => Err(format!(
                "{name} works only in a session Magic Context compacts."
            )),
            "ctx_reduce" => self.ctx_reduce(input),
            "ctx_keep" if self.features.ctx_keep => self.ctx_keep(settings, input),
            "ctx_memory" => {
                let db = self
                    .db
                    .as_ref()
                    .ok_or("ctx_memory needs the context store")?;
                let project = self
                    .project
                    .as_ref()
                    .ok_or("Error: Could not resolve project identity for memory action: the session has no project.")?;
                let who = crate::memory_writes::Writer {
                    harness: &self.key.harness,
                    session: &self.key.session,
                    project: &project.id,
                    authority: self.authority.as_ref(),
                };
                db.with_connection(|conn| crate::memory_tool::run(conn, &who, input))
            }
            "ctx_search" => {
                let db = self
                    .db
                    .as_ref()
                    .ok_or("ctx_search needs the context store")?;
                let empty = std::collections::BTreeMap::new();
                let mut scope = self.search_scope(settings, &empty);
                if let Some(answer) =
                    db.with_connection(|conn| crate::search::by_ids(conn, &scope, input))
                {
                    return answer;
                }
                // Embedded once, before the store is touched, so the request
                // to the endpoint never holds the connection.
                let query = input.get("query").and_then(Value::as_str).unwrap_or("");
                let embedded = match &settings.embedding {
                    Some(provider)
                        if crate::search::needs_embedding(
                            input,
                            settings.memory_enabled,
                            settings.git_commits_enabled,
                        ) =>
                    {
                        provider
                            .embed_query(query.trim())
                            .await
                            .map(|vector| (vector, provider.model_id(), provider.chunk_model_id()))
                    }
                    _ => None,
                };
                scope.semantic = embedded.as_ref().map(|(vector, model_id, chunk_model_id)| {
                    crate::search::sources::Semantic {
                        vector,
                        model_id,
                        chunk_model_id,
                    }
                });
                self.search_reranked(client, settings, db, &scope, input)
                    .await
            }
            "ctx_note" => {
                let db = self.db.as_ref().ok_or("ctx_note needs the context store")?;
                let scope = crate::context_db::NoteScope {
                    harness: self.key.harness.clone(),
                    session: self.key.session.clone(),
                    project: self.project.as_ref().map(|project| project.id.clone()),
                };
                let anchor = self.index.entries().last().map(|entry| entry.ordinal);
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |elapsed| elapsed.as_millis() as i64);
                crate::notes::run(db, &scope, input, anchor, now)
            }
            "ctx_expand" => {
                let last_summarized = self
                    .summaries
                    .last()
                    .and_then(|summary| u64::try_from(summary.end_message).ok());
                crate::expand::run(client, &self.key, input, last_summarized).await
            }
            other => Err(format!("unknown tool {other}")),
        }
    }

    /// An explicit `ctx_search`, reranked when its query reads as prose and a
    /// reranker is configured (see [`crate::search::rerank`]). The store is
    /// not held while the reranker scores, and any failure keeps the ordinary
    /// ranking.
    async fn search_reranked<C: RunnerClient>(
        &self,
        client: &C,
        settings: &Settings,
        db: &ContextDb,
        scope: &crate::search::Scope<'_>,
        input: &Value,
    ) -> Result<String, String> {
        use crate::search::rerank::{self, Reranker, Skipped};
        let query = input
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let prose = settings.rerank != Reranker::Off && rerank::is_prose_query(query);
        // Synapse's model is pinned before any lane is read, so a missing
        // Synapse costs no extra retrieval.
        let mut pinned = None;
        if prose && settings.rerank == Reranker::Synapse {
            match client
                .synapse_call(&self.key, "models.list", serde_json::json!({}))
                .await
                .map_err(Skipped)
                .and_then(rerank::pin)
            {
                Ok(pin) => pinned = Some(pin),
                Err(Skipped(reason)) => rerank::log_fallback(&reason),
            }
        }
        let pool = match (&settings.rerank, &pinned) {
            (Reranker::Synapse, Some(_)) => Some(rerank::POOL),
            (Reranker::Remote(remote), _) if prose => Some(remote.top_n),
            _ => None,
        };
        let mut prepared =
            db.with_connection(|conn| crate::search::prepare(conn, scope, input, pool))?;
        let mut skipped_note = None;
        if !prepared.candidates().is_empty() {
            let texts = prepared.candidates().to_vec();
            let scored = match (&settings.rerank, &pinned) {
                (Reranker::Synapse, Some(pin)) => client
                    .synapse_call(
                        &self.key,
                        "rerank.score",
                        rerank::score_request(pin, prepared.query(), &texts),
                    )
                    .await
                    .map_err(Skipped)
                    .and_then(|reply| rerank::scores(reply, pin, texts.len())),
                (Reranker::Remote(remote), _) => {
                    rerank::remote_scores(remote, prepared.query(), &texts).await
                }
                _ => Err(Skipped("validation".into())),
            };
            match scored {
                Ok(scores) => prepared.reorder(&scores),
                Err(Skipped(reason)) => {
                    rerank::log_fallback(&reason);
                    // Only a hosted reranker's skip is shown to the model, as
                    // the plugin does.
                    if matches!(settings.rerank, Reranker::Remote(_)) {
                        skipped_note = Some(rerank::skipped_line(&reason));
                    }
                }
            }
        }
        let mut answer = db.with_connection(|conn| crate::search::finish(conn, scope, prepared));
        if let Some(line) = skipped_note {
            answer.push('\n');
            answer.push_str(&line);
        }
        Ok(answer)
    }

    /// What a search may read for this session: messages up to the last
    /// summary (later ones are in the model's view), and memories other than
    /// those the history head shows in full. The head is the two messages a
    /// view inserts at the start of the request: the baseline of summaries,
    /// docs and memories, and what changed since that baseline.
    fn search_scope<'a>(
        &'a self,
        settings: &Settings,
        empty: &'a std::collections::BTreeMap<i64, String>,
    ) -> crate::search::Scope<'a> {
        let root = self
            .project
            .as_ref()
            .map(|project| std::path::Path::new(&project.root));
        crate::search::Scope {
            harness: &self.key.harness,
            session: &self.key.session,
            project: self.project.as_ref().map(|project| project.id.as_str()),
            cutoff: self
                .summaries
                .last()
                .map_or(0, |summary| summary.end_message),
            seen: self
                .baseline
                .as_ref()
                .map_or(empty, |baseline| &baseline.seen),
            memory_enabled: settings.memory_enabled,
            git_commits_enabled: settings.git_commits_enabled,
            git_repository: root.map(|root| root.join(".git").exists()),
            semantic: None,
        }
    }

    /// The `pre_user` hook: what goes before and after a person's message as
    /// the runner stores it. A message that is only reminders or notices is
    /// not a person's, and gets nothing.
    pub async fn pre_user(
        &self,
        settings: &Settings,
        text: &str,
        now_ms: u64,
    ) -> crate::pre_user::Addition {
        let mut answer = crate::pre_user::Addition::default();
        if !crate::search::text::is_meaningful_user_text(text) {
            return answer;
        }
        if self.features.time_marker && settings.temporal_awareness {
            // The gap runs from the newest message the session holds, the one
            // this message follows, to now, when the message is written.
            if let Some(previous) = self.index.entries().last() {
                answer.prepend =
                    crate::pre_user::time_marker(now_ms.saturating_sub(previous.written_at));
            }
        }
        let auto = &settings.auto_search;
        let prompt = crate::pre_user::prompt_text(text);
        if !self.features.auto_memory
            || !auto.enabled
            || crate::pre_user::has_hint(text)
            || crate::search::text::utf16_len(&prompt) < auto.min_prompt_chars
        {
            return answer;
        }
        let Some(db) = &self.db else {
            return answer;
        };
        let search = async {
            let embedded = match &settings.embedding {
                Some(provider) => provider
                    .embed_query(&prompt)
                    .await
                    .map(|vector| (vector, provider.model_id(), provider.chunk_model_id())),
                None => None,
            };
            let empty = std::collections::BTreeMap::new();
            let mut scope = self.search_scope(settings, &empty);
            scope.semantic = embedded.as_ref().map(|(vector, model_id, chunk_model_id)| {
                crate::search::sources::Semantic {
                    vector,
                    model_id,
                    chunk_model_id,
                }
            });
            db.with_connection(|conn| crate::search::auto_hits(conn, &scope, &prompt))
        };
        let deadline = std::time::Duration::from_millis(crate::pre_user::AUTO_SEARCH_TIMEOUT_MS);
        let Ok(hits) = tokio::time::timeout(deadline, search).await else {
            eprintln!(
                "ck-mc: session {}: memory search took too long; the message has no hint",
                self.key.session
            );
            return answer;
        };
        answer.append =
            crate::search::build_hint(hits, auto.score_threshold, &prompt, now_ms as i64)
                .map(|hint| format!("\n\n{hint}"));
        answer
    }

    /// `ctx_keep`: the model names what it still needs, in order of
    /// importance. Tags are kept in that order up to `keep_max_percentage`
    /// of the usable window; the rest are named in the answer rather than
    /// refused, since a refusal would only cost another turn.
    fn ctx_keep(&mut self, settings: &Settings, input: &Value) -> Result<String, String> {
        let spec = input.get("tags").and_then(Value::as_str).ok_or(
            "ctx_keep needs `tags`, the tags to keep, most important first, such as \"12,3-5\"",
        )?;
        if input
            .get("note")
            .and_then(Value::as_str)
            .is_none_or(|note| note.trim().is_empty())
        {
            return Err(
                "ctx_keep needs `note`: a few lines on where you are and what comes next".into(),
            );
        }
        let tags = reduce::parse_tags_in_order(spec)?;
        let cap = (pass::usable_window(&self.conditions) as f64 * settings.keep_max_percentage
            / 100.0) as u64;
        let mut kept = BTreeSet::new();
        let (mut kept_tags, mut over, mut missing) = (Vec::new(), Vec::new(), Vec::new());
        let mut used = 0;
        for tag in tags {
            let Some((entry, part)) = self.index.find_tag(tag) else {
                missing.push(tag);
                continue;
            };
            let cost = tokens::part(part);
            if used + cost > cap {
                over.push(tag);
                continue;
            }
            used += cost;
            kept.insert((entry.mid.clone(), part.id.clone()));
            kept_tags.push(tag);
        }
        let mut answer = if kept_tags.is_empty() {
            "Keeping only your task and the newest items.".to_owned()
        } else {
            format!(
                "Keeping {} (about {used} tokens), with your task and the newest items.",
                list(&kept_tags)
            )
        };
        answer.push_str(" Everything else before this call is removed before your next step.");
        if !over.is_empty() {
            answer.push_str(&format!(
                " Not kept, over the limit of {cap} tokens: {}.",
                list(&over)
            ));
        }
        if !missing.is_empty() {
            answer.push_str(&format!(" Not found: {}.", list(&missing)));
        }
        self.pending_keep = Some(kept);
        Ok(answer)
    }

    fn ctx_reduce(&mut self, input: &Value) -> Result<String, String> {
        let spec = input
            .get("drop")
            .and_then(Value::as_str)
            .ok_or("ctx_reduce needs `drop`, a list of tag numbers such as \"3-5,8\"")?;
        let tags = reduce::parse_tags(spec)?;
        let first_mid = self.index.entries().first().map(|entry| entry.mid.clone());
        let mut queued = Vec::new();
        let mut missing = Vec::new();
        for tag in tags {
            match self.index.find_tag(tag) {
                // The first message of a session that keeps it is its task.
                // It is answered like any other tag and never dropped:
                // refusing would only cost the model another turn.
                Some((entry, _))
                    if self.features.keep_first_message
                        && Some(&entry.mid) == first_mid.as_ref() =>
                {
                    queued.push(tag);
                }
                Some((entry, part)) => {
                    self.queued.insert((entry.mid.clone(), part.id.clone()));
                    queued.push(tag);
                }
                None => missing.push(tag),
            }
        }
        if !queued.is_empty() {
            self.nudges.reduced();
        }
        if queued.is_empty() && !missing.is_empty() {
            return Err(format!(
                "no valid tags to queue: {} not found",
                list(&missing)
            ));
        }
        let mut answer = format!("Queued {} for removal.", list(&queued));
        if !missing.is_empty() {
            answer.push_str(&format!(" Not found: {}.", list(&missing)));
        }
        Ok(answer)
    }

    fn summary_on_its_way(&self) -> bool {
        self.summarizing
    }

    /// The history head, and the cut when the newest summary's last message
    /// is still in the transcript. Only presets with a summarizer have a
    /// head. A due fold renders `m[0]` again from everything current.
    fn history_ops(&mut self, settings: &Settings) -> (Vec<EditOp>, Option<u64>) {
        if !self.features.summarizer {
            return (Vec::new(), None);
        }
        let mut ops = self.render_head(settings);
        let cut = self.summaries.last().and_then(|last| {
            self.index
                .entries()
                .iter()
                .find(|entry| entry.mid == last.end_message_id)
                .map(|entry| (entry.ordinal, last.end_message_id.clone()))
        });
        if let Some((_, through)) = &cut {
            ops.push(EditOp::Cut {
                through: through.clone(),
            });
        }
        (ops, cut.map(|(ordinal, _)| ordinal))
    }

    /// The history head's edits: `m[0]` (kept unless a fold is due) and
    /// `m[1]` with what changed since. The baseline they set counts once the
    /// runner takes the view.
    ///
    /// When memories cannot be read, the head stays as the latest view shows
    /// it: an empty read would otherwise state every shown memory as removed,
    /// and the next good read as updated again.
    fn render_head(&mut self, settings: &Settings) -> Vec<EditOp> {
        let docs = self
            .project
            .as_ref()
            .map(|project| {
                crate::project_docs::read_project_docs_canonical(&project.root).rendered_block
            })
            .unwrap_or_default();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as i64);
        let shape = self.head_shape(settings);
        // With memory off, the history head shows no memories and no user
        // profile, as the standalone plugin's does. The user profile is the
        // person's, read whatever the session's project.
        let mut memories = Vec::new();
        let (mut profile, mut profile_max_id) = (Vec::new(), 0);
        if let (Some(db), true) = (&self.db, shape.memory_enabled) {
            if let Some(project) = &self.project {
                match db.project_memories(&project.id, now) {
                    Ok(read) => memories = read,
                    Err(error) => return self.head_as_shown(&format!("reading memories: {error}")),
                }
            }
            match db.user_profile() {
                Ok(read) => (profile, profile_max_id) = read,
                Err(error) => return self.head_as_shown(&format!("reading the profile: {error}")),
            }
        }
        let model_key = format!(
            "{}/{}",
            self.conditions.model.provider, self.conditions.model.model
        );
        let history_budget_tokens = shape.history_budget_tokens;
        let fold_inputs = head::Inputs {
            summaries: &self.summaries,
            docs: &docs,
            profile: &profile,
            profile_max_id,
            memories: &memories,
            gone: &[],
            history_budget_tokens,
            history_local_budget_tokens: crate::summary::render::history_local_budget(
                history_budget_tokens as f64,
                Some(&model_key),
            ) as u64,
            memory_budget_tokens: settings.memory_budget_tokens,
            profile_budget_tokens: settings.profile_budget_tokens,
        };
        let active: std::collections::HashSet<i64> =
            memories.iter().map(|memory| memory.id).collect();
        // Shown memories that left the active set get their rows, which say
        // whether they were archived or merged.
        let gone_from = |base: &Baseline| -> Result<Vec<StoredMemory>, String> {
            let missing: Vec<i64> = base
                .shown_ids()
                .into_iter()
                .filter(|id| !active.contains(id))
                .collect();
            match &self.db {
                Some(db) => db.memories_by_ids(&missing),
                None => Ok(Vec::new()),
            }
        };
        let folded = |inputs: &head::Inputs| {
            let mut base = head::fold(inputs);
            base.shape = Some(shape.clone());
            base
        };
        let mut base = match (&self.baseline, self.fold_due) {
            (Some(baseline), false) => baseline.clone(),
            _ => folded(&fold_inputs),
        };
        let gone = match gone_from(&base) {
            Ok(gone) => gone,
            Err(error) => return self.head_as_shown(&format!("reading memory rows: {error}")),
        };
        let (mut m1, mut next, pressure) = head::delta(
            &base,
            &head::Inputs {
                gone: &gone,
                ..fold_inputs
            },
        );
        if self.baseline.is_some()
            && !self.fold_due
            && head::needs_refold(&base, pressure, history_budget_tokens)
        {
            base = folded(&fold_inputs);
            // A fresh fold shows every current memory, so none is gone.
            (m1, next, _) = head::delta(&base, &fold_inputs);
        }
        let ops = head::head_ops(&next.m0, &m1);
        self.next_baseline = Some(next);
        ops
    }

    /// The history head as the latest view shows it, after a read the head
    /// needs failed: nothing about it changes on this pass.
    fn head_as_shown(&mut self, why: &str) -> Vec<EditOp> {
        eprintln!(
            "ck-mc: session {}: history head kept as shown, {why}",
            self.key.session
        );
        self.next_baseline = None;
        self.latest
            .as_ref()
            .map(|view| {
                view.edits
                    .iter()
                    .filter(|edit| head::is_head(&edit.op))
                    .map(|edit| edit.op.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The settings the history head's baseline (`m[0]`) is rendered under,
    /// as they are now.
    fn head_shape(&self, settings: &Settings) -> head::Shape {
        head::Shape {
            memory_enabled: settings.memory_enabled,
            memory_budget_tokens: settings.memory_budget_tokens,
            history_budget_tokens: (crate::pass::usable_window(&self.conditions) as f64
                * settings.execute_threshold_percentage
                / 100.0
                * settings.history_budget_percentage) as u64,
        }
    }

    /// Whether the baseline was rendered under different settings than these. A
    /// baseline from before the shape was recorded counts as unchanged.
    fn head_shape_changed(&self, settings: &Settings) -> bool {
        self.baseline
            .as_ref()
            .and_then(|baseline| baseline.shape.as_ref())
            .is_some_and(|shape| *shape != self.head_shape(settings))
    }

    /// The first view of a session moved in from a standalone host whose
    /// summaries cover its whole transcript: the history head, and a cut
    /// through `newest`, the transcript's last message. The session then
    /// holds it as accepted, ready to be saved.
    pub fn first_view_after_move(&mut self, settings: &Settings, newest: &Cursor) -> View {
        self.fold_due = true;
        let mut ops = self.render_head(settings);
        ops.push(EditOp::Cut {
            through: newest.mid.clone(),
        });
        let version = self.version + 1;
        let view = View::seal(
            version,
            ops.into_iter()
                .map(|op| cortexkit_role_compaction::view::Edit::new(version, op))
                .collect(),
        );
        if let Some(next) = self.next_baseline.take() {
            self.baseline = Some(next);
            self.fold_due = false;
        }
        self.version = version;
        self.cut = Some(newest.ordinal);
        self.index = Index::starting_at(newest.ordinal);
        self.latest = Some(view.clone());
        view
    }

    /// A pass with permission to rebuild: every lane adds the parts it wants
    /// gone, and one view carries them. `None` when no lane has work.
    ///
    /// A view that fails ck-mc's own checks is a bug in a lane. It is logged
    /// and the work it held is dropped, so the same failure does not repeat
    /// on every pass.
    ///
    /// `over_limit` is set when the runner asked for a view because its next
    /// request would not fit, and carries its estimate of that request. The
    /// emergency drop then runs whatever the usage, and the protections that
    /// can yield do.
    ///
    /// Also returns roughly how many tokens the new edits free, plus what the
    /// age sweep has lined up for the next pass.
    fn build(
        &mut self,
        settings: &Settings,
        over_limit: Option<u64>,
        cache_lost: bool,
        keep: Option<&BTreeSet<lanes::PartKey>>,
    ) -> (Option<View>, u64) {
        let (history, cut) = self.history_ops(settings);
        let edited = lanes::Edited::of(self.latest.as_ref(), &self.index, cut);
        let context = lanes::Context {
            index: &self.index,
            edited: &edited,
            protected_tools: &settings.protected_tools,
            keep_first_message: self.features.keep_first_message,
        };
        let usable = pass::usable_window(&self.conditions);
        let floor = settings
            .protected_tokens
            .unwrap_or_else(|| lanes::default_protected_tokens(usable));
        let cutoff = lanes::protected_cutoff(&context, floor);
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
        wanted.extend(lanes::age_sweep(&context, self.reclaim_bookmark));
        let model = &self.conditions.model;
        let anthropic = model.provider.contains("anthropic") || model.model.contains("claude");
        wanted.extend(lanes::reasoning_over_budget(
            &context,
            settings.keep_reasoning_tokens,
            anthropic,
        ));
        wanted.retain(|(key, _)| !self.failed_parts.contains(key));
        let (mut ops, mut covered) = lanes::drop_ops(&context, &wanted);
        let force = pass::in_force_band(&self.conditions, settings);
        // Another rewrite on this pass: a lane edit, a history head or cut
        // that changes, or a ride whose cache is lost anyway.
        let head_changes = history.iter().any(|op| {
            !self
                .latest
                .as_ref()
                .is_some_and(|view| view.edits.iter().any(|edit| edit.op == *op))
        });
        let priced = !ops.is_empty() || head_changes || cache_lost;
        self.next_latch = false;
        if over_limit.is_some() || (force && (priced || !self.emergency_latched)) {
            let emergency = lanes::Emergency {
                prompt_tokens: over_limit
                    .unwrap_or(0)
                    .max(self.conditions.last_prompt_tokens.unwrap_or(0)),
                ceiling_tokens: (usable as f64 * settings.execute_threshold_percentage / 100.0)
                    as u64,
                over_limit: over_limit.is_some(),
                priced,
            };
            let selected = lanes::emergency_drop(&context, cutoff, &emergency);
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
        // Answered images go once content at least as new has been dropped,
        // by an earlier view or by this pass.
        let images = lanes::Images {
            outputs: &self.image_outputs,
            watermark: edited
                .watermark(&self.index)
                .max(lanes::ops_watermark(&self.index, &ops)),
            cutoff,
            over_limit: over_limit.is_some(),
            skip: &covered,
        };
        let (image_ops, image_parts) = lanes::answered_images(&context, &images);
        let caveman_skip: Vec<lanes::PartKey> = covered
            .iter()
            .filter(|key| !stripped_only.contains(key))
            .cloned()
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
        // The age sweep only drops on the pass after the one that sees an
        // output far behind, so the first pass over the threshold frees
        // little by design. What it has lined up for the next pass counts as
        // relief too, or every session would be asked for ctx_keep on its
        // first crossing.
        let lined_up: Vec<lanes::PartKey> =
            lanes::age_sweep(&context, bookmark.max(self.reclaim_bookmark))
                .into_iter()
                .map(|(key, _)| key)
                .filter(|key| !covered.contains(key))
                .collect();
        let freed = freed_tokens(&context, &covered) + freed_tokens(&context, &lined_up);
        self.reclaim_bookmark = self.reclaim_bookmark.max(bookmark);
        ops.extend(history);
        (self.seal(ops, &covered), freed)
    }

    /// Turn a pass's edits into the next view, and forget the queued drops
    /// it covers.
    fn seal(&mut self, ops: Vec<EditOp>, covered: &[lanes::PartKey]) -> Option<View> {
        let version = self.version + 1;
        // With no summary left, the head and the cut go with them.
        let no_history = self.summaries.is_empty();
        let built = view_builder::next_view(
            self.latest.as_ref(),
            self.index.entries(),
            ops,
            &self.conditions.rules,
            version,
            |op| no_history && (head::is_head(op) || matches!(op, EditOp::Cut { .. })),
        );
        match built {
            Ok(Some(view)) => {
                self.version = version;
                self.next_covered = covered.to_vec();
                Some(view)
            }
            // Nothing new to land: what the pass covered was covered already.
            // The head it rendered is the one shown, so a due fold is done:
            // left pending, it would rewrite `m[0]` on a later pass whose
            // cache is still warm.
            Ok(None) => {
                self.forget_queued(covered);
                if let Some(next) = self.next_baseline.take() {
                    self.baseline = Some(next);
                    self.fold_due = false;
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
                self.forget_queued(covered);
                self.failed_parts.extend(covered.iter().cloned());
                self.next_latch = false;
                eprintln!(
                    "ck-mc: session {}: no valid view: {refusal:?}",
                    self.key.session
                );
                None
            }
        }
    }

    /// Whether `view` is over the size limit (compaction contract V5). Views name edits, never
    /// copies, so one this large is a bug in the code that built it. It is
    /// not sent, the runner keeps the view it has, and the queued drops it
    /// carried are forgotten, as for any view that fails ck-mc's own checks.
    fn refuse_oversized(&mut self, view: &View) -> bool {
        let size = serde_json::to_vec(view).map_or(usize::MAX, |bytes| bytes.len());
        if size <= MAX_VIEW_BYTES {
            return false;
        }
        self.next_baseline = None;
        self.next_caveman = None;
        let covered = std::mem::take(&mut self.next_covered);
        self.forget_queued(&covered);
        eprintln!(
            "ck-mc: session {}: view {} not sent: view_too_large ({size} bytes, limit {MAX_VIEW_BYTES})",
            self.key.session, view.version
        );
        true
    }

    /// Hand `view` to the runner. It is accepted first, as unconfirmed, and
    /// the session's state saved, so that whatever happens to the call, a
    /// restarted ck-mc knows the view may be in the runner's hands. A view
    /// the runner refuses, or a call that fails, puts the state back.
    async fn publish<C: RunnerClient>(&mut self, client: &C, view: View) {
        if self.refuse_oversized(&view) {
            return;
        }
        self.accept(view.clone());
        self.save();
        let request = ApplyViewRequest::new(view.clone());
        match client.apply_view(&self.key, request).await {
            Ok(ApplyViewAnswer::Accepted) => {}
            Ok(ApplyViewAnswer::Refused { refusal }) => {
                eprintln!(
                    "ck-mc: session {}: runner refused view {}: {refusal:?}",
                    self.key.session, view.version
                );
                // The runner holds a newer view than ck-mc knows (one handed
                // over before a crash): the next view must be newer still,
                // and the drops this one carried were not at fault.
                let stale = match &refusal {
                    ViewRefusal::StaleVersion { latest, .. } => {
                        self.version = self.version.max(*latest);
                        true
                    }
                    _ => false,
                };
                self.roll_back(view.version, !stale);
            }
            // An answer the contract may add later leaves the outcome
            // unknown (compaction contract W1.5): the view is not sent again,
            // and ck-mc takes whatever view the runner applies.
            Ok(other) => {
                eprintln!(
                    "ck-mc: session {}: unknown answer to view {}: {other:?}",
                    self.key.session, view.version
                );
                self.roll_back(view.version, false);
                self.adopt_runner_view(client).await;
            }
            Err(error) => {
                eprintln!(
                    "ck-mc: session {}: session.apply_view failed: {error:?}",
                    self.key.session
                );
                self.roll_back(view.version, false);
            }
        }
    }

    /// A view handed over before ck-mc restarted that the runner does not
    /// report applying: it may never have arrived, so it is offered again.
    /// A runner that already holds it refuses it as not newer, which
    /// confirms nothing but loses nothing; any other refusal rolls it back.
    async fn offer_unconfirmed_again<C: RunnerClient>(&mut self, client: &C) {
        let Some(view) = self.unconfirmed.last().map(|pending| pending.view.clone()) else {
            return;
        };
        let oldest = self.unconfirmed[0].view.version;
        match client
            .apply_view(&self.key, ApplyViewRequest::new(view.clone()))
            .await
        {
            Ok(ApplyViewAnswer::Accepted) => {}
            Ok(ApplyViewAnswer::Refused {
                refusal: ViewRefusal::StaleVersion { latest, .. },
            }) if latest == view.version => {}
            Ok(ApplyViewAnswer::Refused { refusal }) => {
                eprintln!(
                    "ck-mc: session {}: runner refused view {} offered again: {refusal:?}",
                    self.key.session, view.version
                );
                self.roll_back(oldest, true);
            }
            Ok(other) => {
                eprintln!(
                    "ck-mc: session {}: unknown answer to view {} offered again: {other:?}",
                    self.key.session, view.version
                );
                self.roll_back(oldest, false);
            }
            Err(error) => {
                eprintln!(
                    "ck-mc: session {}: offering view {} again failed: {error:?}",
                    self.key.session, view.version
                );
                self.roll_back(oldest, false);
            }
        }
    }

    /// Save the session's state now, where a store is set.
    fn save(&self) {
        if let Some(store) = &self.store {
            store.save(&self.key, &self.durable());
        }
    }

    /// Forget queued drops that landed or can never land.
    fn forget_queued(&mut self, parts: &[lanes::PartKey]) {
        for part in parts {
            self.queued.remove(part);
            self.refused_once.remove(part);
        }
    }

    /// The runner did not take a view: its queued drops stay queued for the
    /// next one, except those a refused view already carried once.
    fn keep_refused_drops(&mut self) {
        for part in std::mem::take(&mut self.next_covered) {
            if !self.queued.contains(&part) {
                continue;
            }
            if self.refused_once.insert(part.clone()) {
                continue;
            }
            eprintln!(
                "ck-mc: session {}: queued drop of {}/{} forgotten after a second refused view",
                self.key.session, part.0, part.1
            );
            self.queued.remove(&part);
            self.refused_once.remove(&part);
        }
    }

    /// Take `view` as the one the runner shows, unconfirmed until a notice
    /// reports it applied (see [`Unconfirmed`]).
    fn accept(&mut self, view: View) {
        let covered = std::mem::take(&mut self.next_covered);
        let before = Before {
            latest: self.latest.clone(),
            queued: self.queued.clone(),
            refused_once: self.refused_once.clone(),
            emergency_latched: self.emergency_latched,
            baseline: self.baseline.clone(),
            fold_due: self.fold_due,
            caveman: self.caveman.clone(),
            cut: self.cut,
            pruned_turns: self.pruned_turns,
        };
        self.unconfirmed.push(Unconfirmed {
            view: view.clone(),
            covered: covered.clone(),
            before,
        });
        self.forget_queued(&covered);
        if std::mem::take(&mut self.next_latch) {
            self.emergency_latched = true;
        }
        if let Some(next) = self.next_baseline.take() {
            self.baseline = Some(next);
            self.fold_due = false;
        }
        if let Some(next) = self.next_caveman.take() {
            self.caveman = next;
        }
        self.version = self.version.max(view.version);
        self.apply_cut(&view);
        self.latest = Some(view);
    }

    /// Settle the unconfirmed views against what the runner reports: each
    /// one it applies (or a later one it applies) is confirmed, and one it
    /// refused is rolled back with every view built on it.
    fn settle_unconfirmed(&mut self, applied: Option<&AppliedView>, refused: &[u64]) {
        if let Some(applied) = applied {
            // Views are cumulative: applying a view applies every edit of the
            // unconfirmed ones before it.
            if let Some(at) = self
                .unconfirmed
                .iter()
                .position(|pending| same(applied, &pending.view))
            {
                self.unconfirmed.drain(..=at);
            }
        }
        if let Some(version) = refused
            .iter()
            .filter(|version| {
                self.unconfirmed
                    .iter()
                    .any(|pending| pending.view.version == **version)
            })
            .min()
        {
            self.roll_back(*version, true);
        }
    }

    /// Put back what accepting the view `version`, and every view built on
    /// it, changed. Its queued drops are queued again, except one that a
    /// refused view already carried once: a drop the runner keeps refusing
    /// must not make every later pass build a view it refuses.
    fn roll_back(&mut self, version: u64, refused: bool) {
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
        let covered: Vec<lanes::PartKey> = undone
            .iter()
            .flat_map(|pending| pending.covered.iter().cloned())
            .collect();
        let cut_moved = self.cut != before.cut;
        self.latest = before.latest;
        self.queued = before.queued;
        self.refused_once = before.refused_once;
        self.emergency_latched = before.emergency_latched;
        self.baseline = before.baseline;
        self.fold_due = before.fold_due;
        self.caveman = before.caveman;
        self.cut = before.cut;
        self.pruned_turns = before.pruned_turns;
        if cut_moved {
            // The index already forgot what the cut removed; read it again
            // from the cut the runner still shows.
            self.index = Index::starting_at(self.cut.unwrap_or(1));
        }
        if refused {
            self.next_covered = covered;
            self.keep_refused_drops();
        }
    }

    /// A ride's view whose answer never reached the runner (its deadline
    /// passed): the runner never had it.
    pub fn ride_undelivered(&mut self, version: u64) {
        self.roll_back(version, false);
    }

    /// Whether the runner applies a view ck-mc does not expect: neither its
    /// latest nor, while views wait for confirmation, the one before them.
    fn runner_differs(&self, applied: Option<&AppliedView>) -> bool {
        let expected = |view: Option<&View>| match (applied, view) {
            (Some(applied), Some(view)) => same(applied, view),
            (None, None) => true,
            _ => false,
        };
        let waiting = self
            .unconfirmed
            .first()
            .map(|pending| pending.before.latest.as_ref());
        !(expected(self.latest.as_ref()) || waiting.is_some_and(expected))
    }

    /// Take the view the runner applies as ck-mc's own: after a refusal, or
    /// when ck-mc's copy is missing or older (for example after a restore).
    async fn adopt_runner_view<C: RunnerClient>(&mut self, client: &C) {
        match client.applied_view(&self.key).await {
            Ok(answer) => {
                // The runner's view now stands for itself.
                self.unconfirmed.clear();
                if let Some(view) = &answer.view {
                    self.version = self.version.max(view.version);
                    self.apply_cut(view);
                }
                self.latest = answer.view;
            }
            Err(error) => eprintln!(
                "ck-mc: session {}: session.applied_view failed: {error:?}",
                self.key.session
            ),
        }
    }

    /// Bring the index up to `newest` with reads, from the index's own newest
    /// entry on (which may have changed since). If the transcript diverged
    /// from the index, read it all again.
    /// Read from the oldest held entry that may still change, even though
    /// the index already ends where the runner's transcript does.
    async fn sync_from_changeable<C: RunnerClient>(&mut self, client: &C, newest: &Cursor) {
        if self.index.changeable_from().is_some() {
            self.read_until(client, Some(newest), true).await;
        }
    }

    async fn sync<C: RunnerClient>(&mut self, client: &C, newest: Option<&Cursor>) {
        self.read_until(client, newest, false).await;
    }

    /// Read until the index ends at `newest`; with `force`, read at least
    /// once.
    async fn read_until<C: RunnerClient>(
        &mut self,
        client: &C,
        newest: Option<&Cursor>,
        mut force: bool,
    ) {
        let mut rebuilt = false;
        let mut after = self.index.read_after();
        loop {
            if !std::mem::take(&mut force) && self.index.ends_at(newest) {
                return;
            }
            let request = ReadRequest::new(
                Select::After {
                    after_ordinal: after,
                    limit: None,
                },
                Detail::Compact,
            )
            .with_max_bytes(READ_PAGE_BYTES);
            let page = match client.read(&self.key, request).await {
                Ok(page) => page,
                Err(error) => {
                    eprintln!(
                        "ck-mc: session {}: session.read failed: {error:?}",
                        self.key.session
                    );
                    return;
                }
            };
            match self.index.extend(page.entries) {
                Extend::Continued => match page.next_after {
                    Some(next) => after = Some(next),
                    None => {
                        if !self.index.ends_at(page.head.newest.as_ref()) && !rebuilt {
                            self.restart_index(&mut rebuilt, &mut after);
                            continue;
                        }
                        return;
                    }
                },
                Extend::Gap | Extend::Diverged if !rebuilt => {
                    self.restart_index(&mut rebuilt, &mut after)
                }
                Extend::Gap | Extend::Diverged => {
                    eprintln!(
                        "ck-mc: session {}: transcript keeps changing under a read",
                        self.key.session
                    );
                    return;
                }
            }
        }
    }

    /// Read the index again from the cut, the oldest message the model still
    /// sees.
    fn restart_index(&mut self, rebuilt: &mut bool, after: &mut Option<u64>) {
        self.index = Index::starting_at(self.cut.unwrap_or(1));
        *rebuilt = true;
        *after = self.index.read_after();
    }

    /// Drop held work for parts that are no longer in the transcript.
    /// Add the session's new messages to the shared search index.
    fn update_search_index(&self) {
        let Some(db) = &self.db else {
            return;
        };
        let (harness, session) = (&self.key.harness, &self.key.session);
        let entries = self.index.entries();
        if let Err(error) = db
            .with_connection(|conn| crate::search::messages::index(conn, harness, session, entries))
        {
            eprintln!("ck-mc: session {session}: search indexing failed: {error}");
        }
    }

    fn forget_missing(&mut self) {
        let index = &self.index;
        self.queued
            .retain(|(mid, part)| index.find(mid, part).is_some());
        self.image_outputs
            .retain(|(mid, part), _| index.find(mid, part).is_some());
        self.caveman.retain_present(index);
    }

    /// Read in full the tool results with images whose output the
    /// answered-images lane may need and ck-mc has not read yet, then build.
    /// Only a pass on a notice reads, since it may wait on the runner; a ride
    /// must answer before the runner's request, so it builds with what it
    /// has, and a result whose text is missing waits for a later rebuild.
    async fn build_now<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
    ) -> (Option<View>, u64) {
        let edited = lanes::Edited::of(self.latest.as_ref(), &self.index, None);
        let wanted: Vec<lanes::PartKey> = lanes::image_results(&self.index, &edited)
            .into_iter()
            .filter(|key| !self.image_outputs.contains_key(key))
            .collect();
        if !wanted.is_empty() {
            let mids: Vec<String> = wanted
                .iter()
                .map(|(mid, _)| mid.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            let request = ReadRequest::new(Select::Mids { mids }, Detail::Full);
            match client.read(&self.key, request).await {
                Ok(page) => {
                    for entry in page.entries {
                        for part in entry.parts {
                            let key = (entry.mid.clone(), part.id.clone());
                            // Only text read from the part the index holds.
                            let same = self
                                .index
                                .find(&key.0, &key.1)
                                .is_some_and(|(_, held)| held.digest == part.digest);
                            if let (PartBody::Tool(tool), true, true) =
                                (part.body, same, wanted.contains(&key))
                            {
                                if let Some(output) = tool.output {
                                    self.image_outputs.insert(key, output);
                                }
                            }
                        }
                    }
                }
                Err(error) => eprintln!(
                    "ck-mc: session {}: reading tool results with images failed: {error:?}",
                    self.key.session
                ),
            }
        }
        self.build(settings, None, false, None)
    }
}

/// The route's folder. A folder stamped without a project id gives a session
/// with no project: reductions, summaries and session notes work, while
/// memories, project notes, commit search and upkeep stay off until a later
/// Setup's scope names the project. That is said once per Setup.
fn folder_of(route: &Route) -> Option<String> {
    if route.project.is_none() {
        if let Some(folder) = &route.workdir {
            eprintln!(
                "ck-mc: session {} has a folder but no project id ({folder}); \
                 project memories and upkeep are off for it",
                route.session.session
            );
        }
    }
    route
        .project
        .as_ref()
        .map(|project| project.root.clone())
        .or_else(|| route.workdir.clone())
}

fn conditions_of(request: &SetupRequest) -> Conditions {
    Conditions::new(
        request.model.clone(),
        request.context_window,
        request.output_reserve,
        request.rules.clone(),
    )
}

fn list(tags: &[u64]) -> String {
    tags.iter()
        .map(|tag| format!("§{tag}§"))
        .collect::<Vec<_>>()
        .join(", ")
}

pub use crate::nudges::KEEP_KIND;

/// A reminder as a plan template send (compaction contract SR1), delivered in `mode`
/// only (`delivery_order`), so a routine reminder rides the next tool result
/// and never starts a turn of its own. A queued reminder of the same `kind` is
/// replaced by a newer one.
fn reminder(send_id: String, template: TemplateUse, kind: &str, mode: Mode) -> SendRequest {
    SendRequest::template(
        send_id,
        &DeliveryOrder::new(vec![mode])
            .with_dedupe_key(kind)
            .with_template(template),
    )
}

/// Roughly what dropping `covered` frees: the parts not already changed by
/// an earlier view.
fn freed_tokens(context: &lanes::Context, covered: &[lanes::PartKey]) -> u64 {
    covered
        .iter()
        .filter(|(mid, part)| !context.edited.covers(mid, part))
        .filter_map(|(mid, part)| context.index.find(mid, part))
        .map(|(_, part)| tokens::part(part))
        .sum()
}

/// A message's estimated size for the summarizer's boundary.
fn entry_tokens(entry: &cortexkit_role_compaction::read::Entry) -> u64 {
    entry.parts.iter().map(tokens::part).sum()
}

#[cfg(test)]
mod config_tests {
    use super::*;

    #[test]
    fn history_budget_uses_output_reserved_window() {
        use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
        use cortexkit_role_compaction::setup::ModelRef;
        let route = Route {
            session: SessionRef::new("runner", "test", "budget"),
            project: None,
            workdir: None,
            agent_id: None,
        };
        let request = SetupRequest::new(
            "config-test",
            ModelRef::new("test", "model"),
            200_000,
            32_000,
            ProviderRules::new(SignedParts::None, EditCost::Suffix),
            Vec::new(),
            0,
        );
        let session = Session::new(&route, &request, crate::preset::Features::NONE, None);
        assert_eq!(
            session
                .head_shape(&Settings::default())
                .history_budget_tokens,
            16_380
        );
        let settings = crate::config::resolve_for_test(
            serde_json::json!({"execute_threshold_tokens": {"default": 84000}}),
            serde_json::json!({}),
            "test/model",
            168_000,
        );
        assert_eq!(session.head_shape(&settings).history_budget_tokens, 12_600);
    }
}
