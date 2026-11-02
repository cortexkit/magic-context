//! One session's state, and everything that happens to it. A session's jobs
//! run one at a time on its own worker ([`crate::module`]), so nothing here
//! needs a lock.

use std::collections::BTreeSet;

use ck_contract_draft::notice::{Conditions, Event, NoticeRequest};
use ck_contract_draft::read::{Cursor, Detail, ReadRequest, Select, SessionRef};
use ck_contract_draft::ride::{RideCause, RideRequest};
use ck_contract_draft::send::{Delivery, SendRequest};
use ck_contract_draft::setup::SetupRequest;
use ck_contract_draft::view::{
    EditOp, View, ViewCurrentRequest, ViewDelivery, ViewPublishAnswer, ViewPublishRequest,
};
use serde_json::Value;

use crate::client::RunnerClient;
use crate::index::{Extend, Index};
use crate::lanes;
use crate::pass::{self, Settings};
use crate::preset::Features;
use crate::reduce;
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
}

impl Session {
    pub fn new(request: &SetupRequest, features: Features) -> Self {
        Self {
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
        }
    }

    /// The runner called Setup again (it restarted, or the session's model
    /// changed): take the new conditions, and make sure ck-mc's view matches
    /// the one the runner applies.
    pub async fn setup<C: RunnerClient>(
        &mut self,
        client: &C,
        request: &SetupRequest,
        features: Features,
    ) {
        self.features = features;
        self.conditions = conditions_of(request);
        self.seq = 0;
        let ours = self.latest.as_ref().map(View::applied);
        if ours != request.applied_view {
            self.adopt_runner_view(client).await;
        }
        self.sync(client, request.newest.as_ref()).await;
    }

    pub async fn notice<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        notice: NoticeRequest,
    ) {
        if notice.seq <= self.seq && self.seq != 0 {
            return;
        }
        self.seq = notice.seq;
        self.conditions = notice.conditions.clone();
        let mut refused = false;
        for event in &notice.events {
            match event {
                Event::TranscriptChanged { from_ordinal } => {
                    self.index.truncate(*from_ordinal);
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
            return;
        }
        let force = pass::in_force_band(&self.conditions, settings);
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
            text,
            template: Some(KEEP_TEMPLATE.into()),
            delivery: vec![Delivery::Steer],
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
        let view = self.build(settings, over_limit).0?;
        self.accept(view.clone());
        Some(view)
    }

    pub fn view(&self, version: u64) -> Option<View> {
        self.latest.clone().filter(|view| view.version == version)
    }

    /// A `ctx_*` tool call.
    pub fn tool(
        &mut self,
        settings: &Settings,
        name: &str,
        input: &Value,
    ) -> Result<String, String> {
        match name {
            "ctx_reduce" => self.ctx_reduce(input),
            "ctx_keep" if self.features.ctx_keep => self.ctx_keep(settings, input),
            other => Err(format!("unknown tool {other}")),
        }
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
        // Summaries are not built yet in this module, so none is ever on its
        // way, and a session with a summarizer rebuilds on execute like one
        // without.
        false
    }

    /// A pass with permission to rebuild: every lane adds the parts it wants
    /// gone, and one view carries them. `None` when no lane has work.
    ///
    /// A view that fails ck-mc's own checks is a bug in a lane. It is logged
    /// and the work it held is dropped, so the same failure does not repeat
    /// on every pass.
    ///
    /// `over_limit` carries the runner's estimate of a request that would not
    /// fit, for a ride that says so: the emergency drop then runs whatever
    /// the usage, with the protections that can yield yielding.
    ///
    /// Also returns roughly how many tokens the new edits free, plus what the
    /// age sweep has lined up for the next pass.
    fn build(&mut self, settings: &Settings, over_limit: Option<u64>) -> (Option<View>, u64) {
        let edited = lanes::Edited::of(self.latest.as_ref());
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
        (self.seal(ops, &covered), freed)
    }

    /// The view that keeps only what a `ctx_keep` call asked for (see
    /// [`lanes::keep_drops`]), plus every other lane's work, which rides the
    /// same rewrite.
    fn build_keep(&mut self, settings: &Settings, kept: &BTreeSet<lanes::PartKey>) -> Option<View> {
        let edited = lanes::Edited::of(self.latest.as_ref());
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
        let built = view_builder::next_view(
            self.latest.as_ref(),
            self.index.entries(),
            ops,
            &self.conditions.rules,
            version,
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
                eprintln!(
                    "ck-mc: session {}: runner refused view {}: {refusal:?}",
                    self.key.session, view.version
                );
            }
            Err(error) => eprintln!(
                "ck-mc: session {}: view.publish failed: {error:?}",
                self.key.session
            ),
        }
    }

    fn accept(&mut self, view: View) {
        self.version = self.version.max(view.version);
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
        let mut after = self
            .index
            .cursor()
            .and_then(|cursor| cursor.ordinal.checked_sub(1));
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

    fn restart_index(&mut self, rebuilt: &mut bool, after: &mut Option<u64>) {
        self.index = Index::default();
        *rebuilt = true;
        *after = None;
    }

    /// Drop held work for parts that are no longer in the transcript.
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
