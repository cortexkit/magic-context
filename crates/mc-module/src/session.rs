//! One session's state, and everything that happens to it. A session's jobs
//! run one at a time on its own worker ([`crate::module`]), so nothing here
//! needs a lock.

use std::collections::BTreeSet;
use std::sync::Arc;

use ck_contract_draft::notice::{Conditions, Event, NoticeRequest};
use ck_contract_draft::read::{Cursor, Detail, ReadRequest, Select, SessionRef};
use ck_contract_draft::ride::{RideCause, RideRequest};
use ck_contract_draft::send::{Delivery, SendRequest};
use ck_contract_draft::setup::{Project, SetupRequest};
use ck_contract_draft::view::{
    EditOp, View, ViewCurrentRequest, ViewDelivery, ViewPublishAnswer, ViewPublishRequest,
};
use serde_json::Value;

use crate::client::RunnerClient;
use crate::context_db::{ContextDb, StoredCompartment};
use crate::index::{Extend, Index};
use crate::lanes;
use crate::pass::{self, Settings};
use crate::preset::Features;
use crate::reduce;
use crate::summary::head::{self, Baseline};
use crate::summary::run;
use crate::summary::trigger;
use crate::summary::validate::ValidatedChunk;
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
    /// What `m[0]` holds; `None` until the first summary reaches a view.
    baseline: Option<Baseline>,
    /// A summarizer run is in progress.
    summarizing: bool,
    /// The next view re-renders `m[0]`, because the provider cache is lost
    /// anyway.
    fold_due: bool,
    /// Where summaries and memories are kept; absent only in tests.
    db: Option<Arc<ContextDb>>,
    project: Option<Project>,
    /// The baseline a view being published was built on; it replaces
    /// `baseline` once the runner takes the view.
    next_baseline: Option<Baseline>,
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
}

impl Session {
    pub fn new(request: &SetupRequest, features: Features, db: Option<Arc<ContextDb>>) -> Self {
        Self {
            db,
            project: request.project.clone(),
            key: request.session.clone(),
            features,
            conditions: conditions_of(request),
            index: Index::default(),
            latest: None,
            version: 0,
            queued: BTreeSet::new(),
            reclaim_bookmark: 0,
            emergency_latched: false,
            keep_requested: false,
            pending_keep: None,
            seq: 0,
            summaries: Vec::new(),
            baseline: None,
            next_baseline: None,
            summarizing: false,
            fold_due: false,
            head_stale: false,
            nudges: crate::nudges::State::default(),
            cut: None,
            pruned_turns: 0,
        }
    }

    pub fn key(&self) -> &SessionRef {
        &self.key
    }

    /// What the session's settings depend on: its project folder, its model
    /// as `provider/model`, and its usable window.
    pub fn config_inputs(&self) -> (Option<&str>, String, u64) {
        let model = &self.conditions.model;
        (
            self.project.as_ref().map(|project| project.root.as_str()),
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
        // The first read after a restart starts at the cut: nothing before
        // it is visible to the model.
        self.index = Index::starting_at(durable.cut.unwrap_or(0));
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
        request: &SetupRequest,
        features: Features,
    ) {
        self.features = features;
        self.conditions = conditions_of(request);
        self.project = request.project.clone();
        self.seq = 0;
        let ours = self.latest.as_ref().map(View::applied);
        if ours != request.applied_view {
            self.adopt_runner_view(client).await;
        }
        self.sync(client, request.newest.as_ref()).await;
        if self.features.summarizer && self.latest.is_none() && request.newest.is_none() {
            let (view, _) = self.build(settings, None);
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
        if notice.seq <= self.seq && self.seq != 0 {
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
        let mut refused = false;
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
                        self.index = Index::starting_at(self.cut.unwrap_or(0));
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
                Event::ViewRefused { .. } => refused = true,
                Event::MarkerWritten { .. } => {}
            }
        }
        if refused || self.newer_runner_view(&notice) {
            self.adopt_runner_view(client).await;
        }
        if self.index.extend(notice.entries) != Extend::Continued
            || !self.index.ends_at(Some(&notice.newest))
        {
            self.sync(client, Some(&notice.newest)).await;
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
            if let Some(view) = self.build_keep(settings, &kept) {
                self.publish(client, view).await;
            }
            self.keep_requested = false;
            return None;
        }
        let summary = self.summary_due(settings);
        let force = pass::in_force_band(&self.conditions, settings);
        if std::mem::take(&mut self.head_stale) {
            let (view, _) = self.build(settings, None);
            if let Some(view) = view {
                self.publish(client, view).await;
            }
            return summary;
        }
        if execute
            && (force || !self.summary_on_its_way())
            && !pass::signed_thinking_hold(self.index.entries(), &self.conditions, settings)
        {
            let (view, freed) = self.build(settings, None);
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
        let window = self.conditions.context_window;
        let usage = pass::usage(&self.conditions).unwrap_or(0.0) * 100.0;
        let force = pass::in_force_band(&self.conditions, settings);
        let from = self.summarized_through().map_or(0, |ordinal| ordinal + 1);
        let tail =
            trigger::protected_tail_tokens(window, settings.execute_threshold_percentage, usage);
        let entries = self.index.entries();
        let until = trigger::tail_start(entries, entry_tokens, from, tail, force);
        let readable: Vec<&ck_contract_draft::read::Entry> = entries
            .iter()
            .filter(|entry| entry.ordinal >= from && entry.ordinal < until)
            .collect();
        let tokens: u64 = readable.iter().map(|entry| entry_tokens(entry)).sum();
        let budget = trigger::trigger_budget(window, settings.execute_threshold_percentage);
        trigger::should_run(
            usage,
            settings.execute_threshold_percentage,
            force,
            tokens,
            readable.len(),
            budget,
        )?;
        self.summarizing = true;
        Some(run::Request {
            session: self.key.clone(),
            from,
            until,
            summaries: self.summaries.clone(),
            model: self.conditions.model.clone(),
            // A quarter of the summarizer's window, which is the session's own.
            chunk_tokens: ((self.conditions.context_window as f64 * 0.25).round() as u64)
                .clamp(8_000, 50_000),
        })
    }

    /// After a revert removed messages from `ordinal` on, forget the summaries
    /// that cover any of them, as standalone does. A head that showed one is
    /// rendered again from what remains.
    fn forget_summaries_from(&mut self, ordinal: u64) {
        let number = ordinal + 1;
        let Some(first) = self
            .summaries
            .iter()
            .position(|summary| summary.end_message as u64 >= number)
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
        self.baseline = None;
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

    /// The last ordinal a summary covers.
    fn summarized_through(&self) -> Option<u64> {
        self.summaries
            .last()
            .map(|summary| (summary.end_message as u64).saturating_sub(1))
    }

    /// A summarizer run ended. New summaries are stored, and when usage is at
    /// the execute threshold the view that shows them is built now: the pass
    /// that held its work for this summary is waiting on it.
    pub async fn summary_finished<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        result: Result<Option<ValidatedChunk>, String>,
        now_ms: i64,
    ) {
        self.summarizing = false;
        let validated = match result {
            Ok(Some(validated)) => validated,
            Ok(None) => return,
            Err(error) => {
                eprintln!(
                    "ck-mc: session {}: summary failed: {error}",
                    self.key.session
                );
                return;
            }
        };
        // A revert during the run may have removed what it summarized.
        let present = |mid: &str| self.index.entries().iter().any(|entry| entry.mid == mid);
        if validated.compartments.is_empty()
            || !validated.compartments.iter().all(|summary| {
                present(&summary.end_message_id) && present(&summary.start_message_id)
            })
        {
            return;
        }
        if let Some(db) = &self.db {
            if let Err(error) = db.append_compartments(
                &self.key.harness,
                &self.key.session,
                &validated.compartments,
                now_ms,
            ) {
                eprintln!(
                    "ck-mc: session {}: storing summaries failed: {error}",
                    self.key.session
                );
                return;
            }
        }
        self.summaries
            .extend(validated.compartments.iter().map(StoredCompartment::from));
        if pass::at_execute(&self.conditions, settings) {
            let (view, _) = self.build(settings, None);
            if let Some(view) = view {
                self.publish(client, view).await;
            }
        }
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
                crate::nudges::REMINDER_TEMPLATE,
                Delivery::ToolResult,
            ),
            (
                reminders.ceiling,
                crate::nudges::CEILING_TEMPLATE,
                Delivery::Steer,
            ),
        ];
        for (text, template, delivery) in sends {
            let Some(text) = text else {
                continue;
            };
            let request = SendRequest {
                session: self.key.clone(),
                send_id: format!("{template}:{}", self.seq),
                prompt: text,
                template: Some(template.into()),
                delivery: vec![delivery],
                run: None,
            };
            if let Err(error) = client.send(request).await {
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
        if !self.features.ctx_keep
            || self.keep_requested
            || usable == 0
            || freed as f64 >= usable as f64 * settings.keep_min_recovery_percentage / 100.0
        {
            return;
        }
        let usage = pass::usage(&self.conditions).unwrap_or(0.0) * 100.0;
        let text = format!(
            "Your context is {usage:.0}% full, and dropping old tool output freed only {freed} tokens. \
             Call ctx_keep now. In `tags`, list the tags you still need, most important first. \
             In `note`, write a few lines on where you are and what comes next. \
             Everything else before that call, except your task, is then removed."
        );
        let request = SendRequest {
            session: self.key.clone(),
            // One request per stay over the threshold, so the view version
            // that crossed it names it.
            send_id: format!("{KEEP_TEMPLATE}:{}", self.version),
            prompt: text,
            template: Some(KEEP_TEMPLATE.into()),
            delivery: vec![Delivery::Steer],
            run: None,
        };
        match client.send(request).await {
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
        let over_limit =
            (ride.cause == RideCause::OverLimit).then_some(ride.request_tokens.unwrap_or(0));
        // Any other cause loses the cache, so the head folds for free.
        if over_limit.is_none() {
            self.fold_due = true;
        }
        let view = self.build(settings, over_limit).0?;
        self.accept(view.clone());
        Some(view)
    }

    pub fn view(&self, version: u64) -> Option<View> {
        self.latest.clone().filter(|view| view.version == version)
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
                db.with_connection(|conn| crate::search::run(conn, &scope, input))
            }
            "ctx_note" => {
                let db = self.db.as_ref().ok_or("ctx_note needs the context store")?;
                let scope = crate::context_db::NoteScope {
                    harness: self.key.harness.clone(),
                    session: self.key.session.clone(),
                    project: self.project.as_ref().map(|project| project.id.clone()),
                };
                let anchor = self
                    .index
                    .entries()
                    .last()
                    .map(|entry| crate::summary::chunk::message_number(entry.ordinal));
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

    /// What a search may read for this session: messages up to the last
    /// summary (later ones are in the model's view), and memories other than
    /// those the history summary at the start of the request (`m[0]` and
    /// `m[1]`) shows in full.
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

    /// `transform.pre_user`: what goes before and after a person's message as
    /// the runner stores it. A message that is only reminders or notices is
    /// not a person's, and gets nothing.
    pub async fn pre_user(
        &self,
        settings: &Settings,
        text: &str,
        now_ms: u64,
    ) -> ck_contract_draft::wire::PreUserAnswer {
        let mut answer = ck_contract_draft::wire::PreUserAnswer::default();
        if !crate::search::text::is_meaningful_user_text(text) {
            return answer;
        }
        if settings.temporal_awareness {
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
        let (memories, profile, profile_max_id) = match (&self.db, &self.project) {
            (Some(db), Some(project)) => {
                let memories = db
                    .project_memories(&project.id, now)
                    .unwrap_or_else(|error| {
                        eprintln!(
                            "ck-mc: session {}: reading memories failed: {error}",
                            self.key.session
                        );
                        Vec::new()
                    });
                let (profile, profile_max_id) = db.user_profile().unwrap_or_default();
                (memories, profile, profile_max_id)
            }
            _ => (Vec::new(), Vec::new(), 0),
        };
        let history_budget_tokens =
            (self.conditions.context_window as f64 * settings.execute_threshold_percentage / 100.0
                * settings.history_budget_percentage) as u64;
        let fold_inputs = head::Inputs {
            summaries: &self.summaries,
            docs: &docs,
            profile: &profile,
            profile_max_id,
            memories: &memories,
            gone: &[],
            history_budget_tokens,
            memory_budget_tokens: settings.memory_budget_tokens,
            profile_budget_tokens: settings.profile_budget_tokens,
        };
        let base = match (&self.baseline, self.fold_due) {
            (Some(baseline), false) => baseline.clone(),
            _ => head::fold(&fold_inputs),
        };
        // Shown memories that left the active set: their rows say whether
        // they were archived or merged into another.
        let active: std::collections::HashSet<i64> =
            memories.iter().map(|memory| memory.id).collect();
        let missing: Vec<i64> = base
            .shown_ids()
            .into_iter()
            .filter(|id| !active.contains(id))
            .collect();
        let gone = match &self.db {
            Some(db) => db.memories_by_ids(&missing).unwrap_or_default(),
            None => Vec::new(),
        };
        let inputs = head::Inputs {
            gone: &gone,
            ..fold_inputs
        };
        let (m1, next) = head::delta(&base, &inputs);
        let ops = head::head_ops(&next.m0, &m1);
        self.next_baseline = Some(next);
        ops
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
                .map(|op| ck_contract_draft::view::Edit::new(version, op))
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
    fn build(&mut self, settings: &Settings, over_limit: Option<u64>) -> (Option<View>, u64) {
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
        // that keep a call, then the rest.
        let mut wanted: Vec<(lanes::PartKey, lanes::Shape)> = self
            .queued
            .iter()
            .map(|key| (key.clone(), lanes::Shape::Default))
            .collect();
        wanted.extend(lanes::superseded_edits(
            &context,
            cutoff,
            self.reclaim_bookmark,
        ));
        wanted.extend(lanes::spent_control_plane(&context, cutoff));
        wanted.extend(lanes::duplicate_lookups(&context, cutoff));
        wanted.extend(lanes::age_sweep(&context, self.reclaim_bookmark));
        wanted.extend(lanes::reasoning_over_budget(
            &context,
            settings.keep_reasoning_tokens,
        ));
        let (mut ops, mut covered) = lanes::drop_ops(&context, &wanted);
        let force = pass::in_force_band(&self.conditions, settings);
        let priced = !ops.is_empty();
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
                wanted.extend(selected);
                (ops, covered) = lanes::drop_ops(&context, &wanted);
                self.emergency_latched = true;
            }
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

    /// The view that keeps only what a `ctx_keep` call asked for (see
    /// [`lanes::keep_drops`]), plus every other lane's work, which rides the
    /// same rewrite.
    fn build_keep(&mut self, settings: &Settings, kept: &BTreeSet<lanes::PartKey>) -> Option<View> {
        let edited = lanes::Edited::of(self.latest.as_ref(), &self.index, None);
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
        let mut wanted: Vec<(lanes::PartKey, lanes::Shape)> = self
            .queued
            .iter()
            .map(|key| (key.clone(), lanes::Shape::Default))
            .collect();
        wanted.extend(lanes::keep_drops(&context, kept, cutoff));
        let (ops, covered) = lanes::drop_ops(&context, &wanted);
        self.seal(ops, &covered)
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
        for part in covered {
            self.queued.remove(part);
        }
        match built {
            Ok(Some(view)) => {
                self.version = version;
                Some(view)
            }
            Ok(None) => None,
            Err(refusal) => {
                eprintln!(
                    "ck-mc: session {}: no valid view: {refusal:?}",
                    self.key.session
                );
                None
            }
        }
    }

    async fn publish<C: RunnerClient>(&mut self, client: &C, view: View) {
        let request = ViewPublishRequest {
            session: self.key.clone(),
            delivery: ViewDelivery::Inline { view: view.clone() },
        };
        match client.publish(request).await {
            Ok(ViewPublishAnswer::Accepted) => self.accept(view),
            Ok(ViewPublishAnswer::Refused { refusal }) => {
                self.next_baseline = None;
                eprintln!(
                    "ck-mc: session {}: runner refused view {}: {refusal:?}",
                    self.key.session, view.version
                );
            }
            Err(error) => {
                self.next_baseline = None;
                eprintln!(
                    "ck-mc: session {}: view.publish failed: {error:?}",
                    self.key.session
                );
            }
        }
    }

    fn accept(&mut self, view: View) {
        if let Some(next) = self.next_baseline.take() {
            self.baseline = Some(next);
            self.fold_due = false;
        }
        self.version = self.version.max(view.version);
        self.apply_cut(&view);
        self.latest = Some(view);
    }

    /// Whether the runner applies a view ck-mc does not hold: newer than its
    /// latest, or a different one under the same version.
    fn newer_runner_view(&self, notice: &NoticeRequest) -> bool {
        match (&notice.applied_view, &self.latest) {
            (Some(applied), Some(latest)) => {
                applied.version > latest.version
                    || (applied.version == latest.version && applied.checksum != latest.checksum)
            }
            (Some(_), None) => true,
            (None, _) => false,
        }
    }

    /// Take the view the runner applies as ck-mc's own: after a refusal, or
    /// when ck-mc's copy is missing or older (for example after a restore).
    async fn adopt_runner_view<C: RunnerClient>(&mut self, client: &C) {
        match client
            .current(ViewCurrentRequest {
                session: self.key.clone(),
            })
            .await
        {
            Ok(answer) => {
                if let Some(view) = &answer.view {
                    self.version = self.version.max(view.version);
                    self.apply_cut(view);
                }
                self.latest = answer.view;
            }
            Err(error) => eprintln!(
                "ck-mc: session {}: view.current failed: {error:?}",
                self.key.session
            ),
        }
    }

    /// Bring the index up to `newest` with reads, from the index's own newest
    /// entry on (which may have changed since). If the transcript diverged
    /// from the index, read it all again.
    async fn sync<C: RunnerClient>(&mut self, client: &C, newest: Option<&Cursor>) {
        let mut rebuilt = false;
        let mut after = self.index.read_after();
        loop {
            if self.index.ends_at(newest) {
                return;
            }
            let request = ReadRequest {
                session: self.key.clone(),
                select: Select::After {
                    after_ordinal: after,
                    limit: None,
                },
                detail: Detail::Compact,
                max_bytes: Some(READ_PAGE_BYTES),
            };
            let page = match client.read(request).await {
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
        self.index = Index::starting_at(self.cut.unwrap_or(0));
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
    }
}

fn conditions_of(request: &SetupRequest) -> Conditions {
    Conditions {
        model: request.model.clone(),
        context_window: request.context_window,
        output_reserve: request.output_reserve,
        rules: request.rules,
        last_prompt_tokens: None,
    }
}

fn list(tags: &[u64]) -> String {
    tags.iter()
        .map(|tag| format!("§{tag}§"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The template name of the request to call `ctx_keep`.
pub const KEEP_TEMPLATE: &str = "mc.ctx_keep";

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
fn entry_tokens(entry: &ck_contract_draft::read::Entry) -> u64 {
    entry.parts.iter().map(tokens::part).sum()
}
