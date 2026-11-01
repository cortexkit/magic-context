//! One session's state, and everything that happens to it. A session's jobs
//! run one at a time on its own worker ([`crate::module`]), so nothing here
//! needs a lock.

use std::collections::BTreeSet;

use ck_contract_draft::notice::{Conditions, Event, NoticeRequest};
use ck_contract_draft::read::{Cursor, Detail, ReadRequest, Select, SessionRef};
use ck_contract_draft::ride::RideRequest;
use ck_contract_draft::setup::SetupRequest;
use ck_contract_draft::view::{
    View, ViewCurrentRequest, ViewDelivery, ViewPublishAnswer, ViewPublishRequest,
};
use serde_json::Value;

use crate::client::RunnerClient;
use crate::index::{Extend, Index};
use crate::lanes;
use crate::pass::{self, Settings};
use crate::preset::Features;
use crate::reduce;
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
        if pass::at_execute(&self.conditions, settings)
            && !self.summary_on_its_way()
            && !pass::signed_thinking_hold(self.index.entries(), &self.conditions, settings)
        {
            if let Some(view) = self.build(settings) {
                self.publish(client, view).await;
            }
        }
    }

    /// A ride: the runner is about to send a request that rewrites the cache
    /// anyway, or would not fit. Everything held lands now.
    pub fn ride(&mut self, settings: &Settings, ride: &RideRequest) -> Option<View> {
        self.conditions = ride.conditions.clone();
        let view = self.build(settings)?;
        self.accept(view.clone());
        Some(view)
    }

    pub fn view(&self, version: u64) -> Option<View> {
        self.latest.clone().filter(|view| view.version == version)
    }

    /// A `ctx_*` tool call.
    pub fn tool(&mut self, name: &str, input: &Value) -> Result<String, String> {
        match name {
            "ctx_reduce" => self.ctx_reduce(input),
            other => Err(format!("unknown tool {other}")),
        }
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
    fn build(&mut self, settings: &Settings) -> Option<View> {
        let edited = lanes::Edited::of(self.latest.as_ref());
        let context = lanes::Context {
            index: &self.index,
            edited: &edited,
            protected_tools: &settings.protected_tools,
            keep_first_message: self.features.keep_first_message,
        };
        let mut wanted: Vec<lanes::PartKey> = self.queued.iter().cloned().collect();
        wanted.extend(lanes::age_sweep(&context, self.reclaim_bookmark));
        wanted.extend(lanes::reasoning_over_budget(
            &context,
            settings.keep_reasoning_tokens,
        ));
        let (ops, covered) = lanes::drop_ops(&context, &wanted);
        let bookmark = lanes::far_behind_bookmark(&context, pass::usable_window(&self.conditions));
        self.reclaim_bookmark = self.reclaim_bookmark.max(bookmark);
        let version = self.version + 1;
        let built = view_builder::next_view(
            self.latest.as_ref(),
            self.index.entries(),
            ops,
            &self.conditions.rules,
            version,
        );
        for part in &covered {
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
