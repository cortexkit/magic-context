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
    AppliedView, ApplyViewAnswer, ApplyViewRequest, EditOp, InsertedImage, View, ViewRefusal,
    MAX_VIEW_BYTES,
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
/// Pages of old messages one pass reads to fill a search index gap.
const SEARCH_GAP_PAGES: usize = 4;

pub struct Session {
    app: crate::app_read::SessionState,
    app_projection: app_projection::Projection,
    app_decisions: Vec<Value>,
    app_decisions_revision: u64,
    app_decisions_dirty: bool,
    app_cause: String,
    key: SessionRef,
    features: Features,
    preset: crate::catalog::Preset,
    reminder_counter: u64,
    conditions: Conditions,
    /// Whether this session already logged that its runner's conditions
    /// leave out the prompt size while its steps report usage.
    warned_no_prompt: bool,
    /// The runner's counts of its own system text and of the tool
    /// definitions, from the newest notice that carried them. Rides never
    /// carry them, so a ride's conditions don't clear them.
    /// The execute threshold the newest pass ran under, and which setting
    /// decided it, for the apps' session metadata.
    pub(crate) threshold: (f64, &'static str),
    pub(crate) surface_tokens: (
        Option<cortexkit_role_compaction::tokens::SurfaceTokens>,
        Option<cortexkit_role_compaction::tokens::SurfaceTokens>,
    ),
    index: Index,
    scan_counts: crate::summary::chunk::CountCache,
    /// No view may use an index left partial by an unsuccessful catch-up.
    index_ready: bool,
    /// The runner refused ck-mc as this session's compaction provider
    /// (`compaction_not_permitted`: its plan names another provider or none,
    /// or it no longer holds the session). ck-mc keeps the session's state but
    /// does no work on it, publishes nothing and answers rides with nothing,
    /// until the runner's next Setup for the session.
    suspended: bool,
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
    /// The bookmark a built view moves `reclaim_bookmark` to once the
    /// runner takes it (or once the pass ends without a view), so an undone
    /// view puts the bookmark back with everything else it changed.
    next_reclaim_bookmark: Option<u64>,
    /// An emergency batch landed during this stay in the force band. Another
    /// one waits until usage leaves the band, or a pass rewrites anyway, so
    /// the band never trickles one rewrite per pass.
    emergency_latched: bool,
    /// Set when the pass being built selected an emergency batch; it latches
    /// only once the runner takes the view.
    next_latch: bool,
    /// Set when the pass being built rewrites anyway (a lane edit, a head or
    /// cut that changes) but selected no emergency batch: once the runner
    /// takes the view, a later batch no longer waits for another rewrite.
    next_rearm: bool,
    /// A summary was published that no view the runner took shows yet: the
    /// next view refreshes the head for it even when nothing else changes.
    summary_unshown: bool,
    /// After a restart, until the view the runner applies is read back:
    /// ck-mc doesn't know which edits the next view must carry.
    latest_unknown: bool,
    /// The `ctx_keep` the pass being built carries out. If the runner
    /// refuses that view or never gets it, the keep waits again: the model
    /// was told everything else goes.
    next_keep: Option<BTreeSet<lanes::PartKey>>,
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
    /// A meaningful prompt whose floor may be lifted on the next notice only.
    floor_pending_for: Option<(u64, String)>,
    /// How much history the summarizer may still read in the drain quota's
    /// current ten-minute window.
    drain: crate::summary::drain::Drain,
    /// The raw tokens the run in progress reserved.
    reservation: Option<crate::summary::drain::Reservation>,
    /// The output text of tool results with answered images, read in full
    /// once, so the answered-images lane can keep the text and mark each
    /// removed image ([`lanes::image_results`]).
    image_outputs: std::collections::BTreeMap<lanes::PartKey, String>,
    /// The session's memory context, fixed at its first Setup, or at its
    /// first `ctx_memory` call if that comes first, and what its writes
    /// record from it.
    memory_context: Option<crate::memory_profile::MemoryContext>,
    authority: Option<crate::memory_levels::Authority>,
    /// Views the runner took but has not yet confirmed it applies, oldest
    /// first, each with the state its acceptance replaced.
    unconfirmed: Vec<Unconfirmed>,
    /// Where the session's state is saved before a view leaves ck-mc, so a
    /// crash never leaves the runner holding a view ck-mc has forgotten.
    store: Option<Arc<crate::store::Store>>,
    /// The mural image `m[0]` last carried: its checksum and the PNG in
    /// base64, as the view sends it. Every view repeats `m[0]` byte for byte
    /// until the next fold, so the image is kept, not drawn again.
    mural_image: Option<(String, String)>,
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
    #[serde(default)]
    head_stale: bool,
    latest: Option<View>,
    queued: BTreeSet<lanes::PartKey>,
    refused_once: BTreeSet<lanes::PartKey>,
    emergency_latched: bool,
    baseline: Option<Baseline>,
    fold_due: bool,
    caveman: lanes::CavemanState,
    cut: Option<u64>,
    pruned_turns: u64,
    #[serde(default)]
    reclaim_bookmark: Option<u64>,
    #[serde(default)]
    summary_unshown: bool,
    #[serde(default)]
    pending_keep: Option<BTreeSet<lanes::PartKey>>,
}

/// Admission for a notice, before any lane selects work or publishes a view.
struct NoticePass {
    summary: Option<run::Request>,
    rebuild: bool,
    head_stale: bool,
}

/// Whether the runner reports applying `view`.
fn same(applied: &AppliedView, view: &View) -> bool {
    applied.version == view.version && applied.checksum == view.checksum
}

impl Session {
    fn counter(&self) -> crate::count::Counter {
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
            app: Default::default(),
            app_projection: Default::default(),
            app_decisions: Vec::new(),
            app_decisions_revision: 0,
            app_decisions_dirty: false,
            app_cause: "publication".into(),
            db,
            project: route.project.clone(),
            workdir: folder_of(route),
            key: route.session.clone(),
            features,
            preset: crate::catalog::Preset::parse(&request.preset)
                .unwrap_or(crate::catalog::Preset::Head),
            reminder_counter: 0,
            conditions: conditions_of(request),
            warned_no_prompt: false,
            surface_tokens: (None, None),
            threshold: (
                crate::pass::Settings::default().execute_threshold_percentage,
                "default",
            ),
            index: Index::default(),
            scan_counts: crate::summary::chunk::CountCache::default(),
            index_ready: true,
            suspended: false,
            latest: None,
            version: 0,
            queued: BTreeSet::new(),
            reclaim_bookmark: 0,
            next_reclaim_bookmark: None,
            emergency_latched: false,
            next_latch: false,
            next_rearm: false,
            summary_unshown: false,
            latest_unknown: false,
            next_keep: None,
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
            floor_pending_for: None,
            drain: Default::default(),
            reservation: None,
            image_outputs: std::collections::BTreeMap::new(),
            memory_context: None,
            authority: None,
            unconfirmed: Vec::new(),
            store: None,
            mural_image: None,
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

    /// Take the session's memory context. It never changes afterwards.
    pub fn set_memory_context(&mut self, context: crate::memory_profile::MemoryContext) {
        if self.memory_context.is_none() {
            self.authority = crate::memory_levels::Authority::from_context(&context);
            self.memory_context = Some(context);
        }
    }

    /// Whether the summarizer may read and admit memories: configured, and
    /// the session's memory profile was not refused. A refused profile keeps
    /// existing memories in the head.
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
        crate::store::Durable {
            app: self.app.clone(),
            compaction: (!self.tools_only).then(|| (self.features, self.conditions.clone())),
            preset: (!self.tools_only).then(|| self.preset.as_str().to_owned()),
            pending_keep: self.pending_keep.clone(),
            head_stale: self.head_stale,
            reminder_counter: self.reminder_counter,
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
            floor_pending_for: self.floor_pending_for.clone(),
            unconfirmed: self.unconfirmed.clone(),
            summary_unshown: self.summary_unshown,
        }
    }

    /// Take back what a previous ck-mc process saved for the session.
    pub fn restore(&mut self, durable: crate::store::Durable) {
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
        self.reminder_counter = durable.reminder_counter;
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
        self.floor_pending_for = durable.floor_pending_for;
        self.unconfirmed = durable.unconfirmed;
        self.summary_unshown = durable.summary_unshown;
        // A view handed over before the restart is the one ck-mc expects
        // the runner to show; Setup settles it.
        self.latest = self.unconfirmed.last().map(|pending| pending.view.clone());
        // Views are cumulative, and ck-mc doesn't store the confirmed one:
        // it reads it back from the runner (`session.applied_view`). Until
        // that read succeeds no view is built, or the next one would carry
        // none of the earlier edits and every dropped part would come back.
        self.latest_unknown = self.latest.is_none() && self.version > 0;
        self.distrust_state_ahead_of_summaries();
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

    /// `mode3.db` and `context.db` are backed up separately, and a restore
    /// can pair this store with an older `context.db` (a night whose
    /// `context.db` capture failed keeps the previous one). Restored state
    /// may then cut, or show in `m[0]`, summaries `context.db` no longer
    /// has; those messages would be neither summarized nor shown. ck-mc
    /// trusts `context.db`: reading starts where its summaries end, `m[0]` is
    /// rendered again, views not yet confirmed are dropped, and the next view
    /// moves the cut back, so the summarizer covers those messages again.
    fn distrust_state_ahead_of_summaries(&mut self) {
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
        if !cut_ahead && !head_ahead {
            return;
        }
        tracing::info!(
            "ck-mc: session {}: saved state is ahead of context.db's summaries (cut {:?}, summaries through {covered:?}); rebuilding from context.db",
            self.key.session, self.cut
        );
        if cut_ahead {
            self.cut = covered;
        }
        if head_ahead {
            self.baseline = None;
        }
        self.unconfirmed.clear();
        self.latest = None;
        self.head_stale = true;
    }

    /// Load the summaries `context.db` already holds for the session, such as
    /// those of a session moved in from a standalone host.
    pub fn load_summaries(&mut self) {
        let Some(db) = &self.db else {
            return;
        };
        match db.compartments(&self.key.harness, &self.key.session) {
            Ok(summaries) => {
                self.summaries = summaries;
                self.app_projection.summaries_dirty = true;
            }
            Err(error) => tracing::warn!(
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
        tracing::info!(
            "ck-mc: session {}: setup ({}, preset {}, model {}/{}, window {}, reserve {}, applied view {:?})",
            self.key.session,
            self.key.harness,
            request.preset,
            request.model.provider,
            request.model.model,
            request.context_window,
            request.output_reserve,
            request.applied_view.as_ref().map(|view| view.version)
        );
        self.features = features;
        self.preset = crate::catalog::Preset::parse(&request.preset).expect("validated preset");
        self.tools_only = false;
        self.suspended = false;
        self.conditions = conditions_of(request);
        self.project = route.project.clone();
        self.workdir = folder_of(route);
        self.seq = 0;
        self.settle_unconfirmed(request.applied_view.as_ref(), &[]);
        self.offer_unconfirmed_again(client).await;
        if !self.reconcile_summaries(client, 1, false).await {
            self.index_ready = false;
            return;
        }
        self.index_ready = self.sync(client, request.newest.as_ref()).await;
        if !self.index_ready {
            return;
        }
        // After the read, so the cut message of the view the runner applies
        // is in the index.
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
        if notice.seq <= self.seq || self.suspended {
            return None;
        }
        let version = self.latest.as_ref().map(|view| view.version);
        let cut = self.cut_ordinal();
        let summary = self.handle_notice(client, settings, notice).await;
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
    ) -> Option<run::Request> {
        self.seq = notice.seq;
        self.conditions = notice.conditions.clone();
        self.threshold = (
            settings.execute_threshold_percentage,
            settings.execute_threshold_source,
        );
        self.surface_tokens = (
            notice.conditions.system_tokens,
            notice.conditions.tools_tokens,
        );
        self.warn_if_prompt_size_missing(&notice.entries);
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
                    if !self.reconcile_summaries(client, *from_ordinal, true).await {
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
                            tracing::warn!(
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
            if extended == Extend::Diverged {
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
            return None;
        }
        // A view the runner applies that ck-mc does not expect (it lost one,
        // or restored an older one) is taken as ck-mc's own. After the read,
        // so the view's cut message is in the index.
        if self.runner_differs(notice.applied_view.as_ref()) {
            self.adopt_runner_view(client).await;
        }
        self.forget_missing();
        self.fill_search_gap(client).await;
        self.update_search_index();
        if !pass::in_force_band(&self.conditions, settings) {
            self.emergency_latched = false;
        }
        let execute = pass::at_execute(&self.conditions, settings);
        if !execute {
            self.keep_requested = false;
        }
        if let Some(kept) = self.pending_keep.take_if(|_| !self.latest_unknown) {
            let (view, _) = self.build(settings, None, false, Some(&kept));
            if let Some(view) = view {
                self.publish(client, view).await;
            }
            self.keep_requested = false;
            return None;
        }
        let decision = self.decide_notice(settings);
        if decision.rebuild {
            let (view, freed) = self.build_now(client, settings).await;
            if let Some(view) = view {
                self.publish(client, view).await;
            }
            if !decision.head_stale {
                self.ask_for_keep_if_short(client, settings, freed).await;
            }
        }
        decision.summary
    }

    /// One permission for the history refresh and every mutation lane. Summary
    /// admission runs first, so a run started here also holds the queued work.
    fn decide_notice(&mut self, settings: &Settings) -> NoticePass {
        let summary = self.summary_due(settings);
        let hold = pass::signed_thinking_hold(self.index.entries(), &self.conditions, settings);
        // A fold for a settings or window change waits out a heavy-thinking
        // turn, as an execute pass does: re-rendering `m[0]` then would drop
        // the signed thinking the model just paid for. The change is found
        // again on the next pass. A head made stale by an undo or a restore
        // can't wait: it shows history that no longer holds.
        if !hold && self.head_shape_changed(settings) {
            self.fold_due = true;
            self.head_stale = true;
        }
        NoticePass {
            summary,
            rebuild: self.head_stale
                || (pass::at_execute(&self.conditions, settings)
                    && (pass::in_force_band(&self.conditions, settings)
                        || !self.summary_on_its_way())
                    && !hold),
            head_stale: self.head_stale,
        }
    }

    /// A summarizer run to start now, if one is due: the session has a
    /// summarizer, none is running, and the history it may read is worth a
    /// run at this usage.
    fn summary_due(&mut self, settings: &Settings) -> Option<run::Request> {
        let threshold = settings.execute_threshold_percentage;
        let usage = pass::usage(&self.conditions).unwrap_or(0.0) * 100.0;
        let prompt = self
            .index
            .entries()
            .iter()
            .rev()
            .find(|entry| trigger::is_meaningful_user(entry))
            .map(|entry| (entry.ordinal, entry.mid.clone()));
        if usage < threshold
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
        let memory_enabled = self.memory_admissions(settings) && self.project.is_some();
        let window = pass::usable_window(&self.conditions);
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
        let model = &self.conditions.model;
        let counter =
            crate::count::Counter::for_model(Some(&format!("{}/{}", model.provider, model.model)));
        let calibration = counter.calibration();
        let ratio = calibration
            .prose_ratio
            .max(calibration.tools_ratio)
            .max(1.0);
        let scan_lines = (trigger::scan_budget(budget) as f64 / ratio).floor() as u64;
        let bounded = |tail_tokens: u64, lift: bool| {
            let until = trigger::tail_start(entries, entry_tokens, from, tail_tokens, lift);
            trigger::cap_run(entries, entry_removed_tokens, from, until, cap)
        };
        let after_drops = force
            .then(|| self.usage_after_drops(settings, usage))
            .flatten();
        let mut scan_at = |until: u64| -> Option<trigger::Scan> {
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
            })
        };
        let pressure = trigger::Pressure {
            usage,
            threshold,
            force,
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
        // shrunk cannot re-arm the same mark on this evaluation.
        let lift_floor = self.floor_pending_for.take().is_some();
        let mut until = bounded(tail, force || lift_floor);
        let mut decision = decide(until);
        if decision.is_none() && force {
            // Nothing to read in the force band: the protected tail shrinks
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
        self.summarizing = true;
        tracing::info!(
            "ck-mc: session {}: summary started over messages {from}..{until} (~{requested} tokens)",
            self.key.session
        );
        // The lift is spent only by a run that actually starts.
        if lift_floor {
            self.floor_lifted_for = prompt.map(|(_, mid)| mid);
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
                    "ck-mc: session {}: deleting reverted summaries failed: {error}",
                    self.key.session
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

    /// A notice may be acknowledged before its revert runs, or arrive after
    /// a read already saw the replacement branch. Validate summary endpoints
    /// against the current transcript rather than deleting by a stale event.
    async fn reconcile_summaries<C: RunnerClient>(
        &mut self,
        client: &C,
        from: u64,
        explicit_revert: bool,
    ) -> bool {
        let mut invalid_from = None;
        for summary in self
            .summaries
            .iter()
            .rev()
            .filter(|summary| summary.end_message as u64 >= from)
        {
            if summary.end_message_id.is_empty() {
                // Older rows may lack endpoint metadata. Only an explicit
                // revert, not that missing metadata alone, invalidates them.
                if !explicit_revert {
                    break;
                }
                invalid_from = Some(summary.start_message as u64);
                continue;
            }
            let request = ReadRequest::new(
                Select::Mids {
                    mids: vec![summary.end_message_id.clone()],
                },
                Detail::Compact,
            );
            let page = match client.read(&self.key, request).await {
                Ok(page) => page,
                Err(error) => {
                    tracing::warn!(
                        "ck-mc: session {}: reconciling summaries failed: {error:?}",
                        self.key.session
                    );
                    return false;
                }
            };
            if page.entries.iter().any(|entry| {
                entry.mid == summary.end_message_id && entry.ordinal == summary.end_message as u64
            }) {
                break;
            }
            invalid_from = Some(summary.start_message as u64);
        }
        if let Some(ordinal) = invalid_from {
            self.invalidate_transcript_from(ordinal);
        }
        true
    }

    fn invalidate_transcript_from(&mut self, ordinal: u64) {
        self.forget_summaries_from(ordinal);
        self.index.truncate(ordinal);
        self.app_projection.revert(ordinal);
        if self.cut.is_some_and(|cut| ordinal <= cut) {
            self.cut = self.summarized_through();
            self.index = Index::starting_at(self.cut.unwrap_or(1));
        }
        if let Some(db) = &self.db {
            if let Err(error) = db.with_connection(|conn| {
                crate::search::messages::forget_from(
                    conn,
                    &self.key.harness,
                    &self.key.session,
                    ordinal,
                )
            }) {
                tracing::warn!(
                    "ck-mc: session {}: search index revert failed: {error}",
                    self.key.session
                );
            }
        }
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
        // A cut ends where a summary ends. A runner's cut past the summaries
        // `context.db` holds comes from state newer than it (see
        // `distrust_state_ahead_of_summaries`): the index keeps those
        // messages, and the next view moves the cut back.
        if self
            .summarized_through()
            .is_none_or(|covered| ordinal > covered)
        {
            self.head_stale = true;
            return;
        }
        self.cut = Some(ordinal);
        let gone = self.index.prune_before(ordinal);
        self.app_persist_cut(&gone);
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
            if kind == crate::nudges::CEILING_KIND {
                self.nudges.ceiling_sent = false;
            }
            let Some(send_id) = self.next_reminder_id(kind) else {
                continue;
            };
            let request = reminder(send_id, template, kind, mode);
            if let Err(error) = client.send(&self.key, request).await {
                tracing::warn!(
                    "ck-mc: session {}: session.send failed: {error:?}",
                    self.key.session
                );
            } else if kind == crate::nudges::CEILING_KIND {
                self.nudges.ceiling_sent = true;
            }
        }
    }

    /// ck-mc measures usage only from the conditions' `last_prompt_tokens`.
    /// A runner that leaves it out while its steps report usage keeps the
    /// session below every threshold for good, so say so once per session.
    fn warn_if_prompt_size_missing(&mut self, entries: &[cortexkit_role_compaction::read::Entry]) {
        if self.warned_no_prompt || self.conditions.last_prompt_tokens.is_some() {
            return;
        }
        let reported = entries
            .iter()
            .rev()
            .find_map(|entry| entry.usage.as_ref().and_then(|usage| usage.prompt_tokens));
        if let Some(prompt) = reported {
            self.warned_no_prompt = true;
            tracing::warn!(
                "ck-mc: session {}: the runner's conditions carry no last_prompt_tokens, though its steps report usage ({prompt} prompt tokens); no threshold can be reached",
                self.key.session
            );
        }
    }

    /// Reserve the id before delivery: a crash after sending must not let a
    /// restarted process reuse an id the runner already accepted.
    /// The namespace keeps new ids distinct from persisted runner keys that
    /// used notice numbers or view versions instead of a counter.
    fn next_reminder_id(&mut self, kind: &str) -> Option<String> {
        self.reminder_counter = self.reminder_counter.checked_add(1)?;
        if let Some(store) = &self.store {
            if let Err(error) = store.save(&self.key, &self.durable()) {
                tracing::warn!("ck-mc: {error}");
                return None;
            }
        }
        Some(format!("{kind}:counter:{}", self.reminder_counter))
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
        // One request per stay over the threshold, with a durable send id
        // independent of the view version that crossed it.
        let Some(send_id) = self.next_reminder_id(KEEP_KIND) else {
            return;
        };
        let request = reminder(
            send_id,
            crate::nudges::keep_request(usage, freed),
            KEEP_KIND,
            Mode::Steer,
        );
        match client.send(&self.key, request).await {
            Ok(_) => self.keep_requested = true,
            Err(error) => tracing::warn!(
                "ck-mc: session {}: session.send failed: {error:?}",
                self.key.session
            ),
        }
    }

    /// A ride: the runner is about to send a request that rewrites the cache
    /// anyway, or would not fit. Everything held lands now.
    pub fn ride(&mut self, settings: &Settings, ride: &RideRequest) -> Option<View> {
        if !self.index_ready || self.suspended {
            return None;
        }
        self.conditions = ride.conditions.clone();
        tracing::info!(
            "ck-mc: session {}: ride {:?}, request {:?} tokens, last prompt {:?}, applied view {:?}",
            self.key.session,
            ride.causes,
            ride.request_tokens,
            ride.conditions.last_prompt_tokens,
            ride.applied_view.as_ref().map(|view| view.version),
        );
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
        let kept = self.pending_keep.take_if(|_| !self.latest_unknown);
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
        if !self.tools_only && !self.index_ready && matches!(name, "ctx_reduce" | "ctx_keep") {
            return Err("transcript catch-up is incomplete; retry after the next notice".into());
        }
        match name {
            // The tools that act on the transcript need a session Magic Context
            // compacts; the catalog never offers them to any other.
            "ctx_reduce" | "ctx_expand" | "ctx_keep" if self.tools_only => Err(format!(
                "{name} works only in a session Magic Context compacts."
            )),
            "ctx_reduce" => self.ctx_reduce(client, input).await,
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
                crate::expand::run(client, &self.key, input, last_summarized, self.counter()).await
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
                .map_or(i64::MAX, |summary| summary.end_message),
            visible_messages: (self.summaries.is_empty() && !self.tools_only).then(|| {
                let edited = lanes::Edited::of(self.latest.as_ref(), &self.index, self.cut);
                self.index
                    .entries()
                    .iter()
                    .filter(|entry| {
                        entry
                            .parts
                            .iter()
                            .any(|part| !edited.covers(&entry.mid, &part.id))
                    })
                    .map(|entry| entry.ordinal as i64)
                    .collect()
            }),
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
            // this message follows, to now, when the message is written. A
            // message the host finished counts from when it finished.
            if let Some(previous) = self.index.entries().last() {
                let since = previous.completed_at.unwrap_or(previous.written_at);
                answer.prepend = crate::pre_user::time_marker(now_ms.saturating_sub(since));
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
        let started = std::time::Instant::now();
        let deadline = std::time::Duration::from_millis(crate::pre_user::AUTO_SEARCH_TIMEOUT_MS);
        let search = async {
            let embedded = match &settings.embedding {
                Some(provider) => tokio::time::timeout(
                    std::time::Duration::from_millis(200),
                    provider.embed_query(&prompt),
                )
                .await
                .ok()
                .flatten()
                .map(|vector| (vector, provider.model_id(), provider.chunk_model_id())),
                None => None,
            };
            let empty = std::collections::BTreeMap::new();
            let scope = self.search_scope(settings, &empty);
            let cutoff = scope.cutoff;
            let visible_messages = scope.visible_messages;
            let seen = scope.seen.clone();
            let key = self.key.clone();
            let project = self.project.clone();
            let (memory_enabled, git_commits_enabled, git_repository) = (
                scope.memory_enabled,
                scope.git_commits_enabled,
                scope.git_repository,
            );
            let (db, prompt) = (db.clone(), prompt.clone());
            // SQLite and its connection mutex are synchronous. Keep both off
            // the session worker so the deadline can expire during the read.
            tokio::task::spawn_blocking(move || {
                let scope = crate::search::Scope {
                    harness: &key.harness,
                    session: &key.session,
                    project: project.as_ref().map(|project| project.id.as_str()),
                    cutoff,
                    visible_messages,
                    seen: &seen,
                    memory_enabled,
                    git_commits_enabled,
                    git_repository,
                    semantic: embedded.as_ref().map(|(vector, model_id, chunk_model_id)| {
                        crate::search::sources::Semantic {
                            vector,
                            model_id,
                            chunk_model_id,
                        }
                    }),
                };
                db.with_connection(|conn| crate::search::auto_hits(conn, &scope, &prompt))
            })
            .await
            .unwrap_or_default()
        };
        let Ok(hits) = tokio::time::timeout(deadline, search).await else {
            tracing::info!(
                "ck-mc: session {}: memory search took too long; the message has no hint",
                self.key.session
            );
            return answer;
        };
        if started.elapsed() >= deadline {
            return answer;
        }
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
        answer.push_str(" Messages from the person also stay. Everything else before this call is removed before your next step.");
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

    async fn ctx_reduce<C: RunnerClient>(
        &mut self,
        client: &C,
        input: &Value,
    ) -> Result<String, String> {
        let Some(spec) = input
            .get("drop")
            .and_then(Value::as_str)
            .filter(|spec| !spec.is_empty())
        else {
            return Ok("Error: 'drop' must be provided as a string of tag numbers, for example {\"drop\": \"3-5,8\"}.".into());
        };
        let tags = match reduce::parse_tags(spec) {
            Ok(tags) => tags,
            Err(error) => return Ok(format!("Error: Invalid range syntax. {error}")),
        };
        // The bounded live index no longer holds compacted tags. Ask the raw
        // transcript for missing handles before classifying them as unknown.
        let missing: Vec<_> = tags
            .iter()
            .copied()
            .filter(|tag| self.index.find_tag(*tag).is_none())
            .collect();
        let archived = if missing.is_empty() {
            Vec::new()
        } else {
            crate::reads::by_tags(client, &self.key, missing).await?
        };
        let find = |tag: u64| {
            self.index.find_tag(tag).or_else(|| {
                archived.iter().find_map(|entry| {
                    entry
                        .parts
                        .iter()
                        .find(|part| part.tag == Some(tag))
                        .map(|part| (entry, part))
                })
            })
        };
        let unknown: Vec<_> = tags
            .iter()
            .copied()
            .filter(|tag| find(*tag).is_none())
            .collect();
        if !unknown.is_empty() {
            return Ok(format!(
                "Error: Unknown tag(s) {}. Check available tags in conversation.",
                list(&unknown)
            ));
        }
        let mut self_stamps = 0;
        let mut skipped = Vec::new();
        let mut conflicts = Vec::new();
        let mut selected = Vec::new();
        for tag in tags {
            let (entry, part) = find(tag).expect("all tags resolved");
            if matches!(&part.body, PartBody::Tool(tool) if tool.name.eq_ignore_ascii_case("ctx_reduce"))
            {
                self_stamps += 1;
            } else if entry.role == cortexkit_role_compaction::read::Role::Assistant
                && matches!(&part.body, PartBody::Text { text } if text.trim().is_empty())
            {
                skipped.push(format!("§{tag}§ is provider framing, nothing to reclaim"));
            } else if self.cut.is_some_and(|cut| entry.ordinal <= cut) {
                conflicts.push(format!("§{tag}§ is from before compaction"));
            } else {
                selected.push((entry.mid.clone(), part.id.clone()));
            }
        }
        if !conflicts.is_empty() {
            return Ok(format!(
                "Error: Conflicting operations — {}.",
                conflicts.join("; ")
            ));
        }
        let first_mid = self.index.entries().first().map(|entry| entry.mid.clone());
        let edited = lanes::Edited::of(self.latest.as_ref(), &self.index, self.cut);
        let stamped = selected.len();
        let mut added = false;
        for (mid, part) in selected {
            if (self.features.keep_first_message && Some(&mid) == first_mid.as_ref())
                || edited.covers(&mid, &part)
            {
                continue;
            }
            let key = (mid, part);
            if self.queued.insert(key.clone()) {
                self.app_projection.dirty.insert(key.0.clone());
                self.app.stamps.insert(key, crate::app_read::now_ms());
                added = true;
            }
        }
        if added {
            self.nudges.reduced();
        }
        let mut answer = reduce::reply(stamped, self_stamps);
        if !skipped.is_empty() {
            if !answer.is_empty() {
                answer.push(' ');
            }
            answer.push_str(&format!("Skipped: {}.", skipped.join("; ")));
        }
        if answer.is_empty() {
            answer =
                "All requested tags were already queued or processed. No new action is needed."
                    .into();
        }
        Ok(answer)
    }

    fn summary_on_its_way(&self) -> bool {
        self.features.summarizer && (self.summarizing || self.floor_pending_for.is_some())
    }

    /// The history head, and the cut when the newest summary's last message
    /// is still in the transcript. Only presets with a summarizer have a
    /// head. A due fold renders `m[0]` again from everything current.
    fn history_ops(&mut self, settings: &Settings) -> (Vec<EditOp>, Option<u64>) {
        if !self.features.summarizer {
            return (Vec::new(), None);
        }
        let mut ops = self.render_head(settings);
        // A head kept as the latest view shows it (a read it needs failed,
        // see `head_as_shown`, which leaves no next baseline) carries no
        // newer summary. The cut then stays where that view has it: moving
        // it would hide messages whose summary the head does not show.
        let held = self.next_baseline.is_none();
        let through = if held {
            self.latest.as_ref().and_then(|view| {
                view.edits.iter().find_map(|edit| match &edit.op {
                    EditOp::Cut { through } => Some(through.clone()),
                    _ => None,
                })
            })
        } else {
            self.summaries
                .last()
                .map(|last| last.end_message_id.clone())
        };
        let cut = through.and_then(|through| {
            let entries = self.index.entries();
            let end = entries.iter().position(|entry| entry.mid == through)?;
            // A tool still running can't be cut (compaction contract W6.5),
            // yet the summarizer reads past a call left running long ago, as
            // the plugin does. The cut then stops before it, so views keep
            // landing; the summary may repeat what those messages still show
            // until the runner finishes or fails the call.
            let running = entries[..=end].iter().position(|entry| {
                entry.parts.iter().any(|part| match &part.body {
                    PartBody::Tool(tool) => !crate::neutral::is_finished(&tool.status),
                    _ => false,
                })
            });
            let Some(running) = running else {
                return Some((entries[end].ordinal, through));
            };
            tracing::info!(
                "ck-mc: session {}: the cut stops before message {}, whose tool call is still running",
                self.key.session, entries[running].ordinal
            );
            // With nothing held before the running call, no new cut: the
            // view carries the cut the runner has now.
            let before = running.checked_sub(1)?;
            Some((entries[before].ordinal, entries[before].mid.clone()))
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
        let mut workspace = None;
        let (mut profile, mut profile_max_id) = (Vec::new(), 0);
        if let (Some(db), true) = (&self.db, shape.memory_enabled) {
            if let Some(project) = &self.project {
                match db.with_connection(|conn| {
                    let resolved = crate::workspace::Workspace::resolve(conn, &project.id)?;
                    let read = resolved.memories(conn, now, true)?;
                    Ok::<_, rusqlite::Error>((resolved, read))
                }) {
                    Ok((resolved, read)) => {
                        workspace = Some(resolved);
                        memories = read;
                    }
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
            counter: crate::count::Counter::for_model(Some(&model_key)),
            summaries: &self.summaries,
            docs: &docs,
            profile: &profile,
            profile_max_id,
            memories: &memories,
            workspace: workspace.as_ref(),
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
        // A fold draws the mural afresh; between folds `m[0]` keeps the one
        // it was folded with, as in the plugin.
        let mut drawn: Option<Option<crate::mural::Mural>> = None;
        let mut folded = |inputs: &head::Inputs| {
            let mural =
                drawn.get_or_insert_with(|| self.draw_mural(settings, shape.memory_enabled, now));
            let mut base = head::fold(
                inputs,
                mural.as_ref().map(|mural| mural.content_hash.as_str()),
            );
            base.shape = Some(shape.clone());
            base
        };
        let mut fresh_fold = true;
        let mut base = match (&self.baseline, self.fold_due) {
            (Some(baseline), false) => {
                fresh_fold = false;
                baseline.clone()
            }
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
            && head::needs_refold(&base, pressure, history_budget_tokens, fold_inputs.counter)
        {
            base = folded(&fold_inputs);
            fresh_fold = true;
            // A fresh fold shows every current memory, so none is gone.
            (m1, next, _) = head::delta(&base, &fold_inputs);
        }
        if let Some(Some(mural)) = drawn {
            self.keep_mural(mural);
        }
        let image = next.mural.as_deref().and_then(|hash| self.mural_png(hash));
        let mut ops = head::head_ops(&next.m0, &m1, image);
        // Between folds `m[0]` is exactly what the runner last applied. That
        // is normally what the baseline renders, but not after ck-mc adopted
        // a newer view from the runner (its own saved state was older, as
        // after a restore): re-rendering the older baseline would rewrite
        // the cached prefix from its start. The older baseline still drives
        // `m[1]`, which may then repeat what `m[0]` shows until the next fold.
        if !fresh_fold {
            if let Some(shown) = self.latest.as_ref().and_then(|view| {
                view.edits.iter().find_map(|edit| match &edit.op {
                    EditOp::Insert { message, .. } if message.id == head::M0_ID => {
                        Some(edit.op.clone())
                    }
                    _ => None,
                })
            }) {
                if let Some(m0) = ops.iter_mut().find(
                    |op| matches!(op, EditOp::Insert { message, .. } if message.id == head::M0_ID),
                ) {
                    *m0 = shown;
                }
            }
        }
        self.next_baseline = Some(next);
        ops
    }

    /// The memory mural for a fold, or `None` when it is off, the model
    /// doesn't read images, or there is nothing worth drawing. It shows the
    /// project's own memories that the head's memory budget leaves out, as
    /// the plugin's `resolveMuralForM0` does. A failure to draw is logged and
    /// leaves the mural out of this fold.
    fn draw_mural(
        &self,
        settings: &Settings,
        memory_enabled: bool,
        now: i64,
    ) -> Option<crate::mural::Mural> {
        if !settings.mural_enabled
            || !memory_enabled
            || self.conditions.accepts_images != Some(true)
        {
            return None;
        }
        let (db, project) = (self.db.as_ref()?, self.project.as_ref()?);
        let drawn = db
            .project_memories(&project.id, now)
            .map_err(|error| error.to_string())
            .and_then(|memories| {
                db.with_connection(|conn| {
                    crate::mural::ensure(
                        conn,
                        &project.id,
                        &memories,
                        settings.memory_budget_tokens,
                        now,
                        self.counter(),
                    )
                })
                .map_err(|error| error.to_string())
            });
        drawn.unwrap_or_else(|error| {
            tracing::warn!(
                "ck-mc: session {}: the memory mural was left out of this fold: {error}",
                self.key.session
            );
            None
        })
    }

    /// Keep a newly drawn mural: in memory for the views that repeat `m[0]`,
    /// and in the store for after a restart.
    fn keep_mural(&mut self, mural: crate::mural::Mural) {
        use base64::Engine as _;
        if let Some(store) = &self.store {
            if let Err(error) = store.save_head_mural(&self.key, &mural.content_hash, &mural.png) {
                tracing::warn!("ck-mc: {error}");
            }
        }
        let data = base64::engine::general_purpose::STANDARD.encode(&mural.png);
        self.mural_image = Some((mural.content_hash, data));
    }

    /// The image for the mural with checksum `hash`, as a view carries it.
    /// After a restart it comes from the store, so `m[0]` keeps its bytes.
    fn mural_png(&mut self, hash: &str) -> Option<InsertedImage> {
        use base64::Engine as _;
        if self
            .mural_image
            .as_ref()
            .is_none_or(|(kept, _)| kept != hash)
        {
            let png = self
                .store
                .as_ref()
                .and_then(|store| store.head_mural(&self.key, hash));
            let Some(png) = png else {
                tracing::info!(
                    "ck-mc: session {}: the mural image m[0] shows is gone; m[0] goes without it",
                    self.key.session
                );
                return None;
            };
            let data = base64::engine::general_purpose::STANDARD.encode(&png);
            self.mural_image = Some((hash.to_owned(), data));
        }
        let (_, data) = self.mural_image.as_ref()?;
        Some(InsertedImage::new("image/png", data.clone()))
    }

    /// The history head as the latest view shows it, after a read the head
    /// needs failed: nothing about it changes on this pass.
    /// The held entries with the full output of each tool part whose output
    /// `ops` replace, when ck-mc read it (the answered-images lane does).
    /// The index holds tool output in compact form, so the view checks could
    /// otherwise allow only the part's own number in the replacement and
    /// refuse any other tag its original text quotes (`foreign_tag`), as the
    /// runner, which checks against the full text, would not. `None` when no
    /// op replaces such an output.
    fn with_replaced_outputs(
        &self,
        ops: &[EditOp],
    ) -> Option<Vec<cortexkit_role_compaction::read::Entry>> {
        let wanted: BTreeSet<lanes::PartKey> = ops
            .iter()
            .filter_map(|op| match op {
                EditOp::Replace {
                    mid, part, field, ..
                } if field == "output" => Some((mid.clone(), part.clone())),
                _ => None,
            })
            .filter(|key| self.image_outputs.contains_key(key))
            .collect();
        if wanted.is_empty() {
            return None;
        }
        let mut entries = self.index.entries().to_vec();
        for entry in &mut entries {
            for part in &mut entry.parts {
                let key = (entry.mid.clone(), part.id.clone());
                if let (true, PartBody::Tool(tool)) = (wanted.contains(&key), &mut part.body) {
                    tool.output = self.image_outputs.get(&key).cloned();
                }
            }
        }
        Some(entries)
    }

    /// After an undo, removed numbers go to new parts (compaction contract
    /// T4), so the age-sweep bookmark can't stay above the highest number
    /// still held: a new output under it would count as far behind at once.
    fn clamp_bookmark_to_held(&mut self) {
        self.clamp_bookmark_to(self.index.entries().len());
    }

    /// Clamp the bookmark to the highest number among the first `count`
    /// held entries.
    fn clamp_bookmark_to(&mut self, count: usize) {
        let held = self.index.entries()[..count]
            .iter()
            .flat_map(|entry| entry.parts.iter())
            .filter_map(|part| part.tag)
            .max()
            .unwrap_or(0);
        self.reclaim_bookmark = self.reclaim_bookmark.min(held);
    }

    /// Whether the history head and cut in `history` differ from the latest
    /// view's only in `m[1]`.
    fn only_m1_changes(&self, history: &[EditOp]) -> bool {
        let Some(latest) = &self.latest else {
            return false;
        };
        let shown = |wanted: &EditOp| latest.edits.iter().any(|edit| edit.op == *wanted);
        let mut m1_changed = false;
        for op in history {
            match op {
                EditOp::Insert { message, .. } if message.id == head::M1_ID => {
                    m1_changed |= !shown(op);
                }
                _ if !shown(op) => return false,
                _ => {}
            }
        }
        m1_changed
    }

    fn head_as_shown(&mut self, why: &str) -> Vec<EditOp> {
        tracing::info!(
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
            history_budget_percentage_bp: Some(
                (settings.history_budget_percentage * 10_000.0).round() as u64,
            ),
        }
    }

    /// Whether the baseline was rendered under different settings than these. A
    /// baseline from before the shape was recorded counts as unchanged.
    fn head_shape_changed(&self, settings: &Settings) -> bool {
        self.baseline
            .as_ref()
            .and_then(|baseline| baseline.shape.as_ref())
            .is_some_and(|shape| shape.requires_fold(&self.head_shape(settings)))
    }

    /// The first view of a session moved in from a standalone host whose
    /// summaries cover its whole transcript: the history head, and a cut
    /// through `newest`, the transcript's last message. The session then
    /// holds it as accepted, ready to be saved.
    pub fn first_view_after_move(
        &mut self,
        settings: &Settings,
        newest: &Cursor,
    ) -> Result<View, String> {
        self.fold_due = true;
        let mut ops = self.render_head(settings);
        if self.next_baseline.is_none() || !ops.iter().any(head::is_head) {
            return Err(
                "history_head_unavailable: cannot render the moved session's history head".into(),
            );
        }
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
        Ok(view)
    }

    /// A spent emergency batch waits for another rewrite, but an over-limit
    /// request must reclaim even when the pressure episode is already spent.
    fn emergency_drop_allowed(&self, settings: &Settings, over_limit: bool, priced: bool) -> bool {
        over_limit
            || (pass::in_force_band(&self.conditions, settings)
                && (priced || !self.emergency_latched))
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
        self.next_keep = keep.cloned();
        self.app_cause = if over_limit.is_some() {
            "over_limit"
        } else if cache_lost {
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
        wanted.extend(lanes::age_sweep(&context, self.reclaim_bookmark, cutoff));
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
        // that changes, or a ride whose cache is lost anyway.
        let head_changes = history.iter().any(|op| {
            !self
                .latest
                .as_ref()
                .is_some_and(|view| view.edits.iter().any(|edit| edit.op == *op))
        });
        let priced = !ops.is_empty() || head_changes || cache_lost;
        self.next_latch = false;
        if self.emergency_drop_allowed(settings, over_limit.is_some(), priced) {
            let emergency = lanes::Emergency {
                prompt_tokens: over_limit
                    .unwrap_or(0)
                    .max(self.conditions.last_prompt_tokens.unwrap_or(0)),
                ceiling_tokens: (usable as f64 * settings.execute_threshold_percentage / 100.0)
                    as u64,
                over_limit: over_limit.is_some(),
                priced,
            };
            let mut selected = lanes::emergency_drop(&context, cutoff, &emergency);
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
        // episode armed on such a pass). A lost cache is lost whether or not
        // a view follows; a lane edit or head change counts once taken.
        self.next_rearm = false;
        if priced && !self.next_latch {
            if cache_lost {
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
        // The age sweep only drops on the pass after the one that sees an
        // output far behind, so the first pass over the threshold frees
        // little by design. What it has lined up for the next pass counts as
        // relief too, or every session would be asked for ctx_keep on its
        // first crossing.
        let lined_up: Vec<lanes::PartKey> =
            lanes::age_sweep(&context, bookmark.max(self.reclaim_bookmark), cutoff)
                .into_iter()
                .map(|(key, _)| key)
                .filter(|key| !covered.contains(key))
                .collect();
        let freed = freed_tokens(&context, &covered) + freed_tokens(&context, &lined_up);
        self.next_reclaim_bookmark = Some(self.reclaim_bookmark.max(bookmark));
        // A pass whose lanes have no new edit publishes nothing (PD12). A
        // memory another writer saved changes only `m[1]`: it waits for a
        // pass that rewrites anyway, as the plugin's history refresh rides a
        // rewrite and never starts one.
        let history = if ops.is_empty()
            && !cache_lost
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
        (self.seal(ops, &covered), freed)
    }

    /// Turn a pass's edits into the next view, and forget the queued drops
    /// it covers.
    fn seal(&mut self, ops: Vec<EditOp>, covered: &[lanes::PartKey]) -> Option<View> {
        let version = self.version + 1;
        let retire = retired_history(self.summaries.is_empty(), &ops);
        let full = self.with_replaced_outputs(&ops);
        let built = view_builder::next_view(
            self.latest.as_ref(),
            full.as_deref().unwrap_or(self.index.entries()),
            ops,
            &self.conditions.rules,
            version,
            retire,
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
                self.commit_bookmark();
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
                self.commit_bookmark();
                self.forget_queued(covered);
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

    /// Hand `view` to the runner. It is accepted first, as unconfirmed, and
    /// the session's state saved, so that whatever happens to the call, a
    /// restarted ck-mc knows the view may be in the runner's hands. A view
    /// the runner refuses, or a call that fails, puts the state back.
    async fn publish<C: RunnerClient>(&mut self, client: &C, view: View) {
        if self.suspended || self.refuse_oversized(&view) {
            return;
        }
        self.accept(view.clone());
        if let Err(error) = self.save() {
            tracing::warn!("ck-mc: {error}");
            self.roll_back(view.version, false, None);
            return;
        }
        let request = ApplyViewRequest::new(view.clone());
        match client.apply_view(&self.key, request).await {
            Ok(ApplyViewAnswer::Accepted) => {
                tracing::info!(
                    "ck-mc: session {}: view {} accepted ({} edits)",
                    self.key.session,
                    view.version,
                    view.edits.len()
                );
                self.app_view_status(view.version, "accepted");
            }
            Ok(ApplyViewAnswer::Refused { refusal }) => {
                tracing::warn!(
                    "ck-mc: session {}: runner refused view {}: {refusal:?}",
                    self.key.session,
                    view.version
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
                self.roll_back(view.version, !stale, refusal_part(&refusal));
            }
            // An answer the contract may add later leaves the outcome
            // unknown (compaction contract W1.5): the view is not sent again,
            // and ck-mc takes whatever view the runner applies.
            Ok(other) => {
                tracing::info!(
                    "ck-mc: session {}: unknown answer to view {}: {other:?}",
                    self.key.session,
                    view.version
                );
                self.roll_back(view.version, false, None);
                self.adopt_runner_view(client).await;
            }
            Err(error) => {
                self.runner_call_failed("session.apply_view", &error);
                self.roll_back(view.version, false, None);
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
            Ok(ApplyViewAnswer::Accepted) => {
                self.app_view_status(view.version, "accepted");
            }
            Ok(ApplyViewAnswer::Refused {
                refusal: ViewRefusal::StaleVersion { latest, .. },
            }) if latest == view.version => {}
            Ok(ApplyViewAnswer::Refused { refusal }) => {
                tracing::warn!(
                    "ck-mc: session {}: runner refused view {} offered again: {refusal:?}",
                    self.key.session,
                    view.version
                );
                self.roll_back(oldest, true, None);
            }
            Ok(other) => {
                tracing::info!(
                    "ck-mc: session {}: unknown answer to view {} offered again: {other:?}",
                    self.key.session,
                    view.version
                );
                self.roll_back(oldest, false, None);
            }
            Err(error) => {
                self.runner_call_failed(&format!("offering view {} again", view.version), &error);
                self.roll_back(oldest, false, None);
            }
        }
    }

    /// Save the session's state now, where a store is set.
    fn save(&self) -> Result<(), String> {
        if let Some(store) = &self.store {
            store.save(&self.key, &self.durable())?;
            if self.app_decisions_dirty {
                if let Err(error) = store.save_app_decisions(&self.key, &self.app_decisions) {
                    tracing::warn!("ck-mc: {error}");
                }
            }
        }
        Ok(())
    }

    /// Forget queued drops that landed or can never land.
    fn forget_queued(&mut self, parts: &[lanes::PartKey]) {
        for part in parts {
            self.app_projection.dirty.insert(part.0.clone());
            self.queued.remove(part);
            self.refused_once.remove(part);
            self.app_prune_stamps([part.clone()]);
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
            tracing::warn!(
                "ck-mc: session {}: queued drop of {}/{} forgotten after a second refused view",
                self.key.session,
                part.0,
                part.1
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
    fn commit_bookmark(&mut self) {
        if let Some(bookmark) = self.next_reclaim_bookmark.take() {
            self.reclaim_bookmark = self.reclaim_bookmark.max(bookmark);
        }
    }

    fn accept(&mut self, view: View) {
        self.app_record_view(&view);
        let covered = std::mem::take(&mut self.next_covered);
        let before = Before {
            head_stale: self.head_stale,
            latest: self.latest.clone(),
            queued: self.queued.clone(),
            refused_once: self.refused_once.clone(),
            emergency_latched: self.emergency_latched,
            baseline: self.baseline.clone(),
            fold_due: self.fold_due,
            caveman: self.caveman.clone(),
            cut: self.cut,
            pruned_turns: self.pruned_turns,
            reclaim_bookmark: Some(self.reclaim_bookmark),
            summary_unshown: self.summary_unshown,
            pending_keep: self.next_keep.take(),
        };
        self.commit_bookmark();
        self.unconfirmed.push(Unconfirmed {
            view: view.clone(),
            covered: covered.clone(),
            before,
        });
        self.forget_queued(&covered);
        if std::mem::take(&mut self.next_latch) {
            self.emergency_latched = true;
        } else if std::mem::take(&mut self.next_rearm) {
            self.emergency_latched = false;
        }
        if let Some(next) = self.next_baseline.take() {
            self.head_stale = false;
            self.baseline = Some(next);
            self.fold_due = false;
            self.summary_unshown = false;
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
                let stamp_keys: Vec<_> = self
                    .unconfirmed
                    .first()
                    .into_iter()
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
                self.unconfirmed.drain(..=at);
                self.app_prune_stamps(stamp_keys);
                if let Some(first) = self.unconfirmed.first() {
                    self.app_projection
                        .dirty
                        .extend(first.before.queued.iter().map(|key| key.0.clone()));
                }
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
            self.roll_back(*version, true, None);
        }
    }

    /// Put back what accepting the view `version`, and every view built on
    /// it, changed. Its queued drops are queued again, except one that a
    /// refused view already carried once: a drop the runner keeps refusing
    /// must not make every later pass build a view it refuses.
    fn roll_back(&mut self, version: u64, refused: bool, culprit: Option<lanes::PartKey>) {
        if let Some(record) = self
            .app_decisions
            .iter_mut()
            .find(|r| r["view_version"] == version)
        {
            let status = if refused { "refused" } else { "undelivered" };
            if record["status"] != status {
                record["status"] = serde_json::json!(status);
                self.app_decisions_revision += 1;
                self.app_decisions_dirty = true;
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
        self.queued = before.queued;
        self.refused_once = before.refused_once;
        self.emergency_latched = before.emergency_latched;
        self.summary_unshown |= before.summary_unshown;
        if before.pending_keep.is_some() {
            self.pending_keep = before.pending_keep;
        }
        self.baseline = before.baseline;
        self.fold_due = before.fold_due;
        self.head_stale |= undone.iter().any(|pending| pending.before.head_stale);
        self.caveman = before.caveman;
        self.cut = before.cut;
        self.pruned_turns = before.pruned_turns;
        if let Some(bookmark) = before.reclaim_bookmark {
            self.reclaim_bookmark = bookmark;
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
            let at_fault: Vec<lanes::PartKey> = match culprit {
                Some(part) => covered
                    .iter()
                    .filter(|key| **key == part)
                    .cloned()
                    .collect(),
                None => covered.clone(),
            };
            self.failed_parts.extend(
                at_fault
                    .into_iter()
                    .filter(|part| !self.queued.contains(part)),
            );
            self.next_covered = covered;
            self.keep_refused_drops();
        }
    }

    /// A ride's view whose answer never reached the runner (its deadline
    /// passed): the runner never had it.
    pub fn ride_undelivered(&mut self, version: u64) {
        self.roll_back(version, false, None);
    }

    /// Whether the runner applies a view ck-mc does not expect: neither its
    /// latest nor, while views wait for confirmation, the one before them.
    fn runner_differs(&self, applied: Option<&AppliedView>) -> bool {
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
                self.latest_unknown = false;
            }
            Err(error) => self.runner_call_failed("session.applied_view", &error),
        }
    }

    /// Log a failed call to the runner's compaction ops. A
    /// `compaction_not_permitted` refusal suspends the session (see
    /// `suspended`); any other failure leaves it to the next notice.
    fn runner_call_failed(&mut self, what: &str, error: &crate::client::ClientError) {
        tracing::warn!(
            "ck-mc: session {}: {what} failed: {error}",
            self.key.session
        );
        if error.not_permitted() && !self.suspended {
            tracing::warn!(
                "ck-mc: session {}: the runner refused ck-mc as its compaction provider; suspended until its next Setup",
                self.key.session
            );
            self.suspended = true;
            self.index_ready = false;
        }
    }

    /// Bring the index up to `newest` with reads, from the index's own newest
    /// entry on (which may have changed since). If the transcript diverged
    /// from the index, read it all again.
    /// Read from the oldest held entry that may still change, even though
    /// the index already ends where the runner's transcript does.
    async fn sync_from_changeable<C: RunnerClient>(&mut self, client: &C, newest: &Cursor) -> bool {
        if self.index.changeable_from().is_some() {
            return self.read_until(client, Some(newest), true).await;
        }
        true
    }

    async fn sync<C: RunnerClient>(&mut self, client: &C, newest: Option<&Cursor>) -> bool {
        let force = !self.index_ready
            || self
                .cut
                .is_some_and(|cut| newest.map_or(0, |cursor| cursor.ordinal) < cut);
        self.read_until(client, newest, force).await
    }

    /// Read until the index ends at `newest`; with `force`, read at least
    /// once.
    async fn read_until<C: RunnerClient>(
        &mut self,
        client: &C,
        newest: Option<&Cursor>,
        mut force: bool,
    ) -> bool {
        let mut rebuilt = false;
        let mut after = self.index.read_after();
        loop {
            if !std::mem::take(&mut force) && self.index.ends_at(newest) {
                return true;
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
                    self.runner_call_failed("session.entries", &error);
                    return false;
                }
            };
            if self.cut.is_some_and(|cut| {
                page.head.newest.as_ref().map_or(0, |cursor| cursor.ordinal) < cut
            }) {
                if rebuilt {
                    tracing::info!(
                        "ck-mc: session {}: transcript keeps changing under a read",
                        self.key.session
                    );
                    return false;
                }
                self.invalidate_transcript_from(
                    page.head
                        .newest
                        .as_ref()
                        .map_or(1, |cursor| cursor.ordinal + 1),
                );
                self.restart_index(&mut rebuilt, &mut after);
                continue;
            }
            match self
                .index
                .extend_counted(page.entries, page.token_family.as_deref())
            {
                Extend::Continued => match page.next_after {
                    Some(next) => after = Some(next),
                    None => {
                        if !self.index.ends_at(page.head.newest.as_ref()) {
                            if !rebuilt {
                                self.restart_index(&mut rebuilt, &mut after);
                                continue;
                            }
                            tracing::info!(
                                "ck-mc: session {}: transcript keeps changing under a read",
                                self.key.session
                            );
                            return false;
                        }
                        return true;
                    }
                },
                Extend::Gap | Extend::Diverged if !rebuilt => {
                    self.restart_index(&mut rebuilt, &mut after)
                }
                Extend::Gap | Extend::Diverged => {
                    tracing::info!(
                        "ck-mc: session {}: transcript keeps changing under a read",
                        self.key.session
                    );
                    return false;
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

    /// Index the messages between the shared search index's end and the
    /// oldest message ck-mc holds, read from the runner. The index only
    /// grows over contiguous messages, so without this a gap below the held
    /// window would leave every later message unsearchable too. A gap
    /// appears when a session moves in from the standalone plugin (`ck-mc
    /// move-in`) and the plugin's index stopped short of the cut, or when
    /// ck-mc first starts on a session after its cut. Reads at most a few pages per pass; the next pass goes on.
    async fn fill_search_gap<C: RunnerClient>(&self, client: &C) {
        let Some(db) = &self.db else {
            return;
        };
        let Some(first) = self.index.entries().first().map(|entry| entry.ordinal) else {
            return;
        };
        let session = &self.key.session;
        let mark =
            match db.with_connection(|conn| crate::search::messages::watermark(conn, session)) {
                Ok(mark) => mark.max(0) as u64,
                Err(error) => {
                    tracing::warn!("ck-mc: session {session}: search index unreadable: {error}");
                    return;
                }
            };
        if mark + 1 >= first {
            return;
        }
        let mut after = (mark > 0).then_some(mark);
        for _ in 0..SEARCH_GAP_PAGES {
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
                    tracing::info!(
                        "ck-mc: session {session}: search gap from message {} not read: {}",
                        mark + 1,
                        error.message
                    );
                    return;
                }
            };
            let entries: Vec<_> = page
                .entries
                .into_iter()
                .filter(|entry| entry.ordinal < first)
                .collect();
            let Some(last) = entries.last().map(|entry| entry.ordinal) else {
                return;
            };
            if let Err(error) = db.with_connection(|conn| {
                crate::search::messages::index(conn, &self.key.harness, session, &entries)
            }) {
                tracing::warn!("ck-mc: session {session}: search indexing failed: {error}");
                return;
            }
            if last + 1 >= first {
                tracing::info!(
                    "ck-mc: session {session}: search index filled messages {}..{last}",
                    mark + 1
                );
                return;
            }
            match page.next_after {
                Some(next) => after = Some(next),
                None => return,
            }
        }
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
            tracing::warn!("ck-mc: session {session}: search indexing failed: {error}");
        }
    }

    fn forget_missing(&mut self) {
        let index = &self.index;
        let mut removed = Vec::new();
        self.queued.retain(|key| {
            let keep = index.find(&key.0, &key.1).is_some();
            if !keep {
                removed.push(key.clone());
            }
            keep
        });
        self.image_outputs
            .retain(|(mid, part), _| index.find(mid, part).is_some());
        self.caveman.retain_present(index);
        // A keep whose parts have all left the transcript is forgotten. A
        // keep that named nothing keepable from the start still stands: the
        // model was told everything else goes, so its view must still land.
        if let Some(kept) = &mut self.pending_keep {
            let had_parts = !kept.is_empty();
            kept.retain(|(mid, part)| index.find(mid, part).is_some());
            if had_parts && kept.is_empty() {
                self.pending_keep = None;
            }
        }
        self.app_prune_stamps(removed);
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
                Err(error) => tracing::warn!(
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
            tracing::info!(
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
    let mut conditions = Conditions::new(
        request.model.clone(),
        request.context_window,
        request.output_reserve,
        request.rules.clone(),
    );
    conditions.accepts_images = request.accepts_images;
    conditions
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

/// What summarizing a message removes from the model's view: its text and
/// tool calls (see [`tokens::removed_by_summary`]).
fn entry_removed_tokens(entry: &cortexkit_role_compaction::read::Entry) -> u64 {
    entry.parts.iter().map(tokens::removed_by_summary).sum()
}

#[cfg(test)]
mod summary_weight_tests {
    use super::*;
    use cortexkit_role_compaction::part::{Part, PartBody};
    use cortexkit_role_compaction::read::{Entry, Role};
    use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
    use cortexkit_role_compaction::setup::ModelRef;
    use cortexkit_role_compaction::tokens::PartTokens;

    fn fixture(output_tokens: u64) -> Session {
        let route = Route {
            session: SessionRef::new("test", "mock", "summary-weight"),
            project: None,
            workdir: None,
            agent_id: None,
        };
        let request = SetupRequest::new(
            "summary-weight-test",
            ModelRef::new("test", "model"),
            100_000,
            0,
            ProviderRules::new(SignedParts::None, EditCost::Suffix),
            Vec::new(),
            1,
        );
        // A session with a summarizer, the only feature these tests need.
        let features = crate::preset::Features {
            summarizer: true,
            ..crate::preset::Features::NONE
        };
        let mut session = Session::new(&route, &request, features, None);
        session.conditions.last_prompt_tokens = Some(64_000);
        let mut text = Part::new(
            "text",
            PartBody::Text {
                text: "seed".into(),
            },
        );
        text.tokens = Some(PartTokens::count(1));
        let tool = |output| {
            let mut part: Part = serde_json::from_value(serde_json::json!({
                "id": "tool", "kind": "tool", "call_id": "read", "name": "read",
                "input": {"path": "a"}, "status": "completed", "digest": "d",
                "output_bytes": output * 4,
            }))
            .unwrap();
            part.tokens = Some(PartTokens::tool(8, output));
            part
        };
        session.index.extend_counted(
            vec![
                Entry::new(1, "seed", Role::Assistant, 1, vec![text]),
                Entry::new(2, "large", Role::Assistant, 2, vec![tool(output_tokens)]),
                Entry::new(3, "tail", Role::Assistant, 3, vec![tool(8_000)]),
            ],
            Some("test"),
        );
        session
    }

    #[test]
    fn summary_cap_and_drain_admit_a_small_head_followed_by_large_tool_output() {
        let mut session = fixture(30_000);
        let request = session
            .summary_due(&Settings::default())
            .expect("meaningful head");
        assert_eq!((request.from, request.until), (1, 3));
        assert_eq!(session.drain.spent, 9);
        assert_eq!(session.reservation.unwrap().tokens, 9);
    }

    #[test]
    fn summary_tail_and_meaningful_threshold_still_use_full_size() {
        let settings = Settings::default();
        let mut below = fixture(5_990);
        assert!(
            below.summary_due(&settings).is_none(),
            "5,999 raw tokens are not meaningful"
        );
        let mut at = fixture(5_991);
        let request = at
            .summary_due(&settings)
            .expect("6,000 raw tokens are meaningful");
        // The last tool's 8,000 output tokens protect it even though its call is tiny.
        assert_eq!(request.until, 3);
        assert_eq!(at.drain.spent, 9);
    }
}

/// The part a runner's view refusal names as at fault, if it names one.
fn refusal_part(refusal: &ViewRefusal) -> Option<lanes::PartKey> {
    match refusal {
        ViewRefusal::UnknownPart { mid, part }
        | ViewRefusal::StalePart { mid, part }
        | ViewRefusal::BadField { mid, part, .. }
        | ViewRefusal::Conflict { mid, part }
        | ViewRefusal::RunningTool { mid, part }
        | ViewRefusal::ForeignTag { mid, part, .. } => Some((mid.clone(), part.clone())),
        _ => None,
    }
}

/// Which of the previous view's history edits (the history head's two
/// messages and the cut) leave the next view. When an undo takes away a
/// session's last summary, the cut goes and so does a head this pass no
/// longer renders. A head this pass renders again stays as it was, with the
/// version that introduced it: the head also carries project docs and
/// memories, so a session with no summaries yet still shows one. Retiring
/// and re-adding it on every pass would give it a newer version each time,
/// which publishes a view on every execute pass and, under signed thinking,
/// makes every later thinking block look invalid.
fn retired_history(no_summaries: bool, ops: &[EditOp]) -> impl Fn(&EditOp) -> bool {
    let rendered: Vec<EditOp> = ops
        .iter()
        .filter(|op| head::is_head(op) || matches!(op, EditOp::Cut { .. }))
        .cloned()
        .collect();
    move |op| {
        no_summaries
            && (head::is_head(op) || matches!(op, EditOp::Cut { .. }))
            && !rendered.contains(op)
    }
}

#[cfg(test)]
mod retired_history_tests {
    use super::*;
    use cortexkit_role_compaction::view::{Edit, InsertAt, InsertedMessage};

    fn head_insert(id: &str, text: &str) -> EditOp {
        EditOp::Insert {
            at: InsertAt::Start,
            message: InsertedMessage::new(
                id,
                cortexkit_role_compaction::read::Role::User,
                vec![text.to_owned()],
            ),
        }
    }

    #[test]
    fn a_head_rendered_again_without_summaries_keeps_its_version() {
        let m0 = head_insert(head::M0_ID, "<project-docs>One crate.</project-docs>");
        let m1 = head_insert(head::M1_ID, "<session-history-since>(no new content)");
        let previous = View::seal(1, vec![Edit::new(1, m0.clone()), Edit::new(1, m1.clone())]);
        let ops = vec![m0.clone(), m1.clone()];
        let retire = retired_history(true, &ops);
        let next = view_builder::next_view(
            Some(&previous),
            &[],
            ops,
            &cortexkit_role_compaction::rules::ProviderRules::new(
                cortexkit_role_compaction::rules::SignedParts::None,
                cortexkit_role_compaction::rules::EditCost::Suffix,
            ),
            2,
            retire,
        )
        .unwrap();
        assert!(next.is_none(), "an unchanged head must publish nothing");
    }

    #[test]
    fn a_head_or_cut_no_longer_rendered_leaves_once_the_summaries_are_gone() {
        let m0 = head_insert(head::M0_ID, "<session-history>…");
        let cut = EditOp::Cut {
            through: "m9".into(),
        };
        let retire = retired_history(true, &[]);
        assert!(retire(&m0) && retire(&cut));
        // With summaries, nothing is retired here; a newer head replaces the
        // old one through the view builder.
        let retire = retired_history(false, &[]);
        assert!(!retire(&m0) && !retire(&cut));
    }
}

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod lifecycle_tests;

#[path = "app_read/projection.rs"]
mod app_projection;

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

#[cfg(test)]
#[path = "../tests/support/agent_surface.rs"]
mod agent_surface_tests;
