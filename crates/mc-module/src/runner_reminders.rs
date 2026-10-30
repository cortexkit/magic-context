//! Runner-lane reminders are sends, never edits to a tool result or user message.
//! Synchronous provider hooks deliberately do not call this module.

use cortexkit_role_llm_runner::delivery_order::{
    self, DeliveryOrder, Mode, PartRef, PlanSender, Slot, Template, TemplateUse,
};
use cortexkit_role_llm_runner::send::SendRequest;
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, path::Path, time::Duration};

use crate::{session_resolver::ProviderRunner, transform};

/// CPU attribution for the single-threaded reminder scaling benchmark.
#[cfg(test)]
pub(crate) mod phase_meter {
    use std::{cell::RefCell, collections::BTreeMap};

    thread_local! {
        static TOTALS: RefCell<BTreeMap<&'static str, (u64, u128)>> = RefCell::default();
    }

    pub struct Timer(&'static str, std::time::Duration);

    pub fn start(phase: &'static str) -> Timer {
        Timer(phase, cpu_time::ThreadTime::now().as_duration())
    }

    impl Drop for Timer {
        fn drop(&mut self) {
            TOTALS.with_borrow_mut(|totals| {
                let total = totals.entry(self.0).or_default();
                total.0 += 1;
                total.1 += cpu_time::ThreadTime::now()
                    .as_duration()
                    .saturating_sub(self.1)
                    .as_nanos();
            });
        }
    }

    pub fn snapshot() -> BTreeMap<&'static str, (u64, u128)> {
        TOTALS.with_borrow(Clone::clone)
    }
}

const MAX: i64 = 100_000;
const DELIVERY: [Mode; 3] = [Mode::TurnSystem, Mode::ToolResult, Mode::Steer];
const SEARCH_DELIVERY: [Mode; 2] = [Mode::ToolResult, Mode::Steer];
const NO_DELIVERY_MODE: &str = "not due: runner cannot land any delivery mode";
const REFUSED_DELIVERY: &str = "not due: runner previously refused this delivery list";
const FORK_REFUSED: &str = "not due: runner refused this session as a fork of a managed session";
/// All reminder kinds expire five minutes after the observation that produced them.
pub const REMINDER_TTL_MS: u64 = 300_000;
/// Allow a queued delivery to appear on the next transcript read after expiry.
pub const DELIVERY_GRACE_MS: u64 = 60_000;
const MAX_PENDING_DELIVERIES: usize = 128;

const BODIES: [(&str, &str); 5] = [
    ("gentle", "Housekeeping: {summary} are reclaimable. Stamp each output with ctx_reduce as soon as you've taken what you need from it; don't wait for the task to finish."),
    ("firm", "{summary} are reclaimable. Make a ctx_reduce pass now over the outputs you've already used, then continue."),
    ("urgent", "{summary} are still unstamped. Call ctx_reduce now, before your next tool call, on every output you've already used."),
    ("sticky", "Still unstamped: {summary}. Stamp the ones you've used with ctx_reduce now."),
    ("channel2", "Your next step: call ctx_reduce on the outputs you've already used ({summary}). Then continue your task."),
];

/// Fixed global plan templates. A hint slot names a part by its host identity
/// (`{mid, part}`), never by a number: the runner renders the number the
/// request carrying the reminder shows for that part.
/// The digest is computed over the role's `{id,text,slots}` object, without metadata.
pub fn templates() -> Vec<Template> {
    let mut templates = Vec::new();
    for (kind, body) in BODIES {
        for count in ["zero", "one", "many"] {
            for hints in 0..=4 {
                let mut slots =
                    BTreeMap::from([("tokens_k".into(), Slot::Integer { min: 0, max: MAX })]);
                let outputs = match count {
                    "zero" => "spent tool outputs",
                    "one" => "1 spent tool output",
                    _ => {
                        slots.insert("count".into(), Slot::Integer { min: 2, max: MAX });
                        "{count} spent tool outputs"
                    }
                };
                let summary = format!("{outputs} (~{{tokens_k}}k tokens)");
                let mut text = if kind == "channel2" {
                    String::new()
                } else {
                    "\n\n".into()
                };
                text.push_str("<system-reminder>\n");
                text.push_str(&body.replace("{summary}", &summary));
                if hints > 0 {
                    text.push_str("\noldest reclaimable: ");
                    for i in 0..hints {
                        if i > 0 {
                            text.push_str(" · ");
                        }
                        text.push_str(&format!("{{tag{i}}}"));
                        slots.insert(format!("tag{i}"), Slot::PartTag);
                    }
                    text.push('.');
                }
                text.push_str("\n</system-reminder>");
                templates.push(Template::new(
                    format!("mc.ctx_reduce.{kind}.{count}.h{hints}.v1"),
                    text,
                    slots,
                ));
            }
        }
    }
    let units = |values: &[&str]| Slot::Enum {
        values: values.iter().map(|v| (*v).into()).collect(),
    };
    let major = Slot::Integer { min: 1, max: MAX };
    templates.push(Template::new(
        "mc.time.single.v1",
        "<!-- +{major}{unit} -->\n",
        BTreeMap::from([
            ("major".into(), major.clone()),
            ("unit".into(), units(&["m", "h", "d", "w"])),
        ]),
    ));
    templates.push(Template::new(
        "mc.time.compound.v1",
        "<!-- +{major}{major_unit} {minor}{minor_unit} -->\n",
        BTreeMap::from([
            ("major".into(), major),
            ("minor".into(), Slot::Integer { min: 1, max: 59 }),
            ("major_unit".into(), units(&["h", "d", "w"])),
            ("minor_unit".into(), units(&["m", "h", "d"])),
        ]),
    ));
    templates
}

/// Core copies `sender` into the session plan's `senders` array. Descriptive
/// digests and delivery preferences are outside the plan's strict template object.
pub fn catalog() -> Value {
    let templates = templates();
    json!({
        "sender": PlanSender::new("magic-context").with_templates(templates.clone()),
        "templates": templates.iter().map(|t| json!({"id":t.id,"digest":delivery_order::template_digest(t),"delivery":DELIVERY})).collect::<Vec<_>>(),
        "search_hint": {"delivery":SEARCH_DELIVERY,"authority":"user"},
        "ttl_ms": REMINDER_TTL_MS,
    })
}

fn template_use(id: &str, slots: Map<String, Value>) -> TemplateUse {
    let templates = templates();
    let template = templates
        .iter()
        .find(|t| t.id == id)
        .expect("known reminder template");
    TemplateUse::new(id, delivery_order::template_digest(template), slots)
}

fn reduce_use(kind: &str, tokens: i64, count: usize, tags: &[HintPart]) -> TemplateUse {
    // Clamp very large transcripts to the template bounds so every integer
    // remains exactly representable by JSON consumers and the send stays valid.
    let count_kind = match count {
        0 => "zero",
        1 => "one",
        _ => "many",
    };
    let hints = tags.len().min(4);
    let mut slots = Map::from_iter([(
        "tokens_k".into(),
        json!(((tokens.max(0) as f64 / 1000.0).round() as i64).min(MAX)),
    )]);
    if count > 1 {
        slots.insert("count".into(), json!(count.min(MAX as usize)));
    }
    for (i, hint) in tags.iter().take(4).enumerate() {
        slots.insert(
            format!("tag{i}"),
            serde_json::to_value(&hint.part).expect("part reference serializes"),
        );
    }
    template_use(
        &format!("mc.ctx_reduce.{kind}.{count_kind}.h{hints}.v1"),
        slots,
    )
}

fn time_use(gap_ms: i64) -> Option<TemplateUse> {
    let prefix = transform::temporal_gap_prefix(gap_ms)?;
    let gap = prefix.strip_prefix("<!-- +")?.strip_suffix(" -->\n")?;
    let parse = |part: &str| -> Option<(i64, String)> {
        Some((
            part[..part.len() - 1].parse().ok()?,
            part[part.len() - 1..].into(),
        ))
    };
    let mut parts = gap.split(' ');
    let (major, unit) = parse(parts.next()?)?;
    // A long idle gap must not produce an integer outside the declared slots.
    let major = major.clamp(1, MAX);
    Some(if let Some(minor) = parts.next() {
        let (minor, minor_unit) = parse(minor)?;
        let minor = minor.clamp(1, 59);
        template_use(
            "mc.time.compound.v1",
            json!({"major":major,"major_unit":unit,"minor":minor,"minor_unit":minor_unit})
                .as_object()?
                .clone(),
        )
    } else {
        template_use(
            "mc.time.single.v1",
            json!({"major":major,"unit":unit}).as_object()?.clone(),
        )
    })
}

/// The notice handler persists this beside its cursor, under its conversation lock.
/// Cadence is advanced only after the runner accepts the corresponding send.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct ReminderState {
    pub meta: mc_store::ModuleMeta,
    last_tool_tag: Option<u64>,
    last_time_message: Option<String>,
    last_search_message: Option<String>,
    #[serde(default)]
    delivery_refusals: DeliveryRefusals,
    #[serde(default)]
    pub(crate) ledger: DeliveryLedger,
    /// The runner refused a send `fork_unsupported`: the session is a fork of
    /// a managed session, so it is never sent another reminder.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) fork_refused: bool,
}

/// Keep refused mode lists only for the runner description under which they were recorded.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
struct DeliveryRefusals {
    #[serde(default)]
    runner_description: Option<Value>,
    #[serde(default)]
    lists: Vec<Vec<Mode>>,
}

impl DeliveryRefusals {
    fn use_description(&mut self, description: &Value) {
        if self.runner_description.as_ref() != Some(description) {
            self.runner_description = Some(description.clone());
            self.lists.clear();
        }
    }

    fn contains(&self, modes: &[Mode]) -> bool {
        self.lists.iter().any(|refused| refused == modes)
    }

    fn record(&mut self, modes: &[Mode]) {
        if !self.contains(modes) {
            self.lists.push(modes.to_vec());
        }
    }
}

/// Accepted sends awaiting one exact content-block echo from the runner.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct DeliveryLedger {
    pending: Vec<SentReminder>,
    latest: BTreeMap<String, u64>,
    serial: u64,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct SentReminder {
    pub text: String,
    pub kind: String,
    pub sent_at_ms: u64,
    pub expires_at_ms: u64,
    serial: u64,
}

impl DeliveryLedger {
    pub(crate) fn retained_bytes(&self) -> usize {
        self.pending
            .iter()
            .map(|sent| std::mem::size_of::<SentReminder>() + sent.text.len() + sent.kind.len())
            .sum::<usize>()
            + self.latest.keys().map(|key| key.len() + 64).sum::<usize>()
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    pub(crate) fn contains(&self, text: &str) -> bool {
        self.pending.iter().any(|sent| sent.text == text)
    }
    pub(crate) fn expire(&mut self, now_ms: u64) {
        self.pending
            .retain(|sent| now_ms <= sent.expires_at_ms.saturating_add(DELIVERY_GRACE_MS));
    }

    fn record(&mut self, send: &PreparedSend, text: String) {
        let sent_at_ms = send.sent_at_ms;
        self.expire(sent_at_ms);
        self.serial = self.serial.saturating_add(1);
        self.latest.insert(send.kind.into(), self.serial);
        self.pending.push(SentReminder {
            text,
            kind: send.kind.into(),
            sent_at_ms,
            expires_at_ms: send.expires_at_ms,
            serial: self.serial,
        });
        if self.pending.len() > MAX_PENDING_DELIVERIES {
            self.pending.remove(0);
        }
    }

    pub(crate) fn recognize(
        &mut self,
        text: &str,
        now_ms: u64,
        written_at: Option<u64>,
    ) -> Option<SentReminder> {
        self.expire(now_ms);
        // Without a write time, an exact authored paste cannot be distinguished
        // from a delivery. Never consume provenance for content predating its send.
        let written_at = written_at?;
        let index = self
            .pending
            .iter()
            .rposition(|sent| sent.text == text && sent.sent_at_ms <= written_at)?;
        Some(self.pending.remove(index))
    }

    pub(crate) fn stale(&self, sent: &SentReminder, now_ms: u64) -> bool {
        now_ms >= sent.expires_at_ms
            || self
                .latest
                .get(&sent.kind)
                .is_some_and(|serial| *serial > sent.serial)
    }
}

/// Facts derived from the runner transcript, not from an untrusted notice body.
/// The handler supplies the same measured baseline and hint selection as the
/// synchronous policy. A ready search hint has already passed lexical-search,
/// score, prompt-length and already-shown-memory guards; no search is awaited.
pub struct ReminderConditions<'a> {
    pub notice_id: &'a str,
    pub now_ms: u64,
    pub real_user_turn_count: u64,
    pub baseline: Option<&'a mc_store::TailHygieneBaseline>,
    /// Newest eligible, unreduced, unserved tool result with text output.
    pub newest_tool_tag: Option<u64>,
    /// The tag hints a reminder names. Selecting them reads every tag in the
    /// unsummarized tail, so they are computed only when a reminder is sent.
    pub hints: &'a (dyn Fn() -> Result<ReminderHints, String> + Sync),
    pub drops_applied: bool,
    /// A fresh measurement, rather than a cached/invalid baseline.
    pub baseline_refreshed: bool,
    /// True only when a hard fold actually advanced transcript coverage.
    pub hard_fold_coverage_advanced: bool,
    /// An authored user message eligible for a temporal marker and/or search hint.
    pub user_message_id: Option<&'a str>,
    pub temporal_enabled: bool,
    /// Created time minus the preceding message's completed (else created) time.
    pub gap_ms: Option<i64>,
    pub ready_search_hint: Option<&'a str>,
}

/// Tag hints for a reduce reminder.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReminderHints {
    /// Already filtered for protection, queued drops, tiny and control outputs.
    pub oldest_reclaimable: Vec<HintPart>,
    /// Separate channel-2 selection: unqueued, unprotected tool tags >=100 tokens.
    pub channel2: Vec<HintPart>,
}

/// One part a reminder names. The send carries only `part`, the part's host
/// identity; `number` is the tag ck-mc's own read showed for it in the
/// current lineage, used to render the text ck-mc expects the runner to
/// deliver, so the delivered copy can be recognized in the transcript.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HintPart {
    pub number: u64,
    pub part: PartRef,
}

impl HintPart {
    pub fn new(number: u64, mid: impl Into<String>, part: impl Into<String>) -> Self {
        Self {
            number,
            part: PartRef::new(mid, part),
        }
    }
}

#[derive(Debug, Default)]
pub struct ReminderOutcome {
    pub issued: Vec<Value>,
    pub not_due: Vec<&'static str>,
    pub errors: Vec<String>,
    /// The hints could not be computed; the caller must retry the notice.
    pub hints_failed: Option<String>,
}

struct PreparedSend {
    kind: &'static str,
    template: Option<TemplateUse>,
    /// The number ck-mc's read shows for each part a template slot names.
    shown: Vec<HintPart>,
    prompt: String,
    sent_at_ms: u64,
    expires_at_ms: u64,
}

impl PreparedSend {
    fn reminder(kind: &'static str, template: TemplateUse, now_ms: u64) -> Self {
        Self {
            kind,
            template: Some(template),
            shown: Vec::new(),
            prompt: String::new(),
            sent_at_ms: now_ms,
            expires_at_ms: now_ms.saturating_add(REMINDER_TTL_MS),
        }
    }

    fn naming(mut self, hints: &[HintPart]) -> Self {
        self.shown = hints.to_vec();
        self
    }

    /// The number this send expects the runner to render for `part`.
    fn shown(&self, part: &PartRef) -> Option<u64> {
        self.shown
            .iter()
            .find(|hint| &hint.part == part)
            .map(|hint| hint.number)
    }

    fn request(&self, project: &Path, session: &str, notice: &str, modes: &[Mode]) -> Value {
        // The immutable payload, not the replacement key, identifies a retry.
        let identity = json!([
            project.to_string_lossy(),
            session,
            notice,
            self.kind,
            self.template,
            self.prompt,
            self.expires_at_ms,
            modes
        ]);
        let send_id =
            crate::sha256_hex(&serde_jcs::to_vec(&identity).expect("send identity serializes"));
        self.wire_request(send_id, modes)
    }

    fn wire_request(&self, send_id: String, modes: &[Mode]) -> Value {
        let mut order = DeliveryOrder::new(modes.to_vec())
            .with_dedupe_key(format!("mc.{}", self.kind))
            .with_expires_at_ms(self.expires_at_ms);
        if let Some(template) = &self.template {
            order = order.with_template(template.clone());
        }
        let mut request = SendRequest::new(&self.prompt, send_id).with_delivery_order(&order);
        if self.template.is_some() {
            request.prompt = None;
        }
        serde_json::to_value(request).expect("typed reminder send serializes")
    }
}

// Pass delivery inputs and both mutable results directly so each send's state changes are visible.
#[allow(clippy::too_many_arguments)]
async fn issue(
    runner: &dyn ProviderRunner,
    project: &Path,
    session: &str,
    notice: &str,
    send: PreparedSend,
    modes: &[Mode],
    state: &mut ReminderState,
    outcome: &mut ReminderOutcome,
) -> bool {
    if modes.is_empty() {
        if !outcome.not_due.contains(&NO_DELIVERY_MODE) {
            outcome.not_due.push(NO_DELIVERY_MODE);
        }
        return false;
    }
    if state.delivery_refusals.contains(modes) {
        if !outcome.not_due.contains(&REFUSED_DELIVERY) {
            outcome.not_due.push(REFUSED_DELIVERY);
        }
        return false;
    }
    // Use the role's renderer, including its digest and slot validation, rather
    // than a second interpolation implementation that could misidentify echoes.
    let text = match &send.template {
        Some(template) => {
            match delivery_order::render(&templates(), template, |part| send.shown(part)) {
                Ok(text) => text,
                Err(error) => {
                    outcome.errors.push(format!("{}: {error:?}", send.kind));
                    return false;
                }
            }
        }
        None => send.prompt.clone(),
    };
    let request = send.request(project, session, notice, modes);
    match runner
        .call(
            project,
            session,
            "session.send",
            request.clone(),
            Duration::from_millis(1_500),
        )
        .await
    {
        Ok(reply) if accepted(&reply) => {
            state.ledger.record(&send, text);
            outcome.issued.push(request);
            true
        }
        Ok(reply) => {
            note_refusal(refusal_code(&reply), modes, state);
            outcome.errors.push(format!("{}: {reply}", send.kind));
            false
        }
        Err(error) => {
            if let crate::session_resolver::SessionResolveError::Refused { code, .. } = &error {
                note_refusal(Some(code), modes, state);
            }
            outcome.errors.push(format!("{}: {error}", send.kind));
            false
        }
    }
}

/// The code of a refused send carried in the answer body. The runner's
/// reply envelope is already removed (`session_resolver::read_runner_reply`).
fn refusal_code(reply: &Value) -> Option<&str> {
    let error = reply.get("error").unwrap_or(reply);
    error.get("code").and_then(Value::as_str)
}

/// Act on a refused send: remember a mode list the runner cannot land, and
/// stop sending into a session the runner knows is a fork. A part a template
/// named that is no longer shown needs nothing: nothing was committed, so the
/// next pass picks its hints again from the current read.
fn note_refusal(code: Option<&str>, modes: &[Mode], state: &mut ReminderState) {
    match code {
        Some(cortexkit_role_llm_runner::errors::DELIVERY_UNSUPPORTED) => {
            state.delivery_refusals.record(modes);
        }
        Some(cortexkit_role_llm_runner::errors::FORK_UNSUPPORTED) => {
            state.fork_refused = true;
        }
        _ => {}
    }
}

fn delivery_modes(
    templated: bool,
    description: &cortexkit_role_llm_runner::describe::RoleDescribe,
) -> Vec<Mode> {
    let modes: &[Mode] = if templated {
        &DELIVERY
    } else {
        &SEARCH_DELIVERY
    };
    modes
        .iter()
        .copied()
        .filter(|mode| {
            description.delivery_order_modes.is_none() || mode.is_declared_by(description)
        })
        .collect()
}

fn accepted(reply: &Value) -> bool {
    use cortexkit_role_llm_runner::send::{SendReply, SendState};
    serde_json::from_value::<SendReply>(reply.clone()).is_ok_and(|reply| {
        matches!(
            reply.send_state(),
            SendState::Pending | SendState::Active | SendState::Finished | SendState::Paused
        )
    })
}

/// Send best-effort reminders without modifying stored tool results or user messages.
///
/// `send_due_reminders(runner.as_ref(), project_root, session, &mut state, &conditions).await`
/// is called after reading new transcript entries and measuring their reclaimable
/// context. Serialize calls per conversation, and persist `state` with the last
/// processed transcript position. `runner` must route to this session's runner.
/// Search results are optional: the user's message never waits for a search.
/// `conditions.baseline` carries the usage/window-adjusted hygiene measurement;
/// `newest_tool_tag` must satisfy the eligibility documented on that field.
pub async fn send_due_reminders(
    runner: &dyn ProviderRunner,
    project_root: &Path,
    session: &str,
    state: &mut ReminderState,
    conditions: &ReminderConditions<'_>,
) -> ReminderOutcome {
    send_due_reminders_impl::<false>(runner, project_root, session, state, conditions).await
}

/// Retain the pre-optimization metadata copy and commit for differential tests.
#[cfg(test)]
pub(crate) async fn send_due_reminders_oracle(
    runner: &dyn ProviderRunner,
    project_root: &Path,
    session: &str,
    state: &mut ReminderState,
    conditions: &ReminderConditions<'_>,
) -> ReminderOutcome {
    send_due_reminders_impl::<true>(runner, project_root, session, state, conditions).await
}

/// Only these fields participate in a speculative channel-1 transition. In particular,
/// block identities and served fingerprints belong to the engine, not the cadence.
fn cadence_meta(meta: &mc_store::ModuleMeta) -> mc_store::ModuleMeta {
    mc_store::ModuleMeta {
        channel1_reduce_suppressed: meta.channel1_reduce_suppressed,
        channel1_last_nudge_undropped: meta.channel1_last_nudge_undropped,
        channel1_last_nudge_level: meta.channel1_last_nudge_level.clone(),
        channel1_last_fire_level: meta.channel1_last_fire_level.clone(),
        channel1_last_fire_ordinal: meta.channel1_last_fire_ordinal,
        ..Default::default()
    }
}

#[cfg(test)]
fn oracle_meta(meta: &mut mc_store::ModuleMeta) -> mc_store::ModuleMeta {
    // Split the original full clone into the identity map and everything else
    // to attribute its historical cost without changing the copied metadata.
    let identities = std::mem::take(&mut meta.block_identity_by_mid);
    let mut next = meta.clone();
    meta.block_identity_by_mid = identities;
    let _meter = phase_meter::start("identity_clone");
    next.block_identity_by_mid = meta.block_identity_by_mid.clone();
    next
}

fn commit_meta<const FULL_META: bool>(state: &mut ReminderState, next: mc_store::ModuleMeta) {
    #[cfg(test)]
    let _meter = phase_meter::start("meta_commit");
    if FULL_META {
        #[cfg(test)]
        {
            let mut old = std::mem::replace(&mut state.meta, next);
            let _meter = phase_meter::start("identity_drop");
            drop(std::mem::take(&mut old.block_identity_by_mid));
        }
        #[cfg(not(test))]
        {
            state.meta = next;
        }
    } else {
        state.meta.channel1_reduce_suppressed = next.channel1_reduce_suppressed;
        state.meta.channel1_last_nudge_undropped = next.channel1_last_nudge_undropped;
        state.meta.channel1_last_nudge_level = next.channel1_last_nudge_level;
        state.meta.channel1_last_fire_level = next.channel1_last_fire_level;
        state.meta.channel1_last_fire_ordinal = next.channel1_last_fire_ordinal;
        state.meta.tail_hygiene_baseline = next.tail_hygiene_baseline;
    }
}

async fn send_due_reminders_impl<const FULL_META: bool>(
    runner: &dyn ProviderRunner,
    project_root: &Path,
    session: &str,
    state: &mut ReminderState,
    conditions: &ReminderConditions<'_>,
) -> ReminderOutcome {
    #[cfg(test)]
    let _total = phase_meter::start("total");
    let mut outcome = ReminderOutcome::default();
    state.ledger.expire(conditions.now_ms);
    if state.fork_refused {
        outcome.not_due.push(FORK_REFUSED);
        return outcome;
    }
    // Older runners may ignore unknown fields and start an unwanted run. Never
    // send until discovery explicitly promises ordered, non-starting delivery.
    let description = match runner
        .call(
            project_root,
            session,
            "role.describe",
            json!({}),
            Duration::from_millis(1_500),
        )
        .await
    {
        Ok(value) => value,
        Err(error) => {
            outcome.errors.push(error.to_string());
            return outcome;
        }
    };
    let describe = match cortexkit_role_llm_runner::describe::check_describe(&description) {
        Ok(describe) if describe.declares("delivery_order") => describe,
        _ => {
            outcome.not_due.push("runner_missing_delivery_order");
            return outcome;
        }
    };
    state.delivery_refusals.use_description(&description);

    #[cfg(test)]
    let meter = phase_meter::start("meta_clone");
    let mut next = if FULL_META {
        #[cfg(test)]
        {
            oracle_meta(&mut state.meta)
        }
        #[cfg(not(test))]
        {
            state.meta.clone()
        }
    } else {
        cadence_meta(&state.meta)
    };
    #[cfg(test)]
    drop(meter);
    // The cadence decisions read only the baseline's scalars. Its per-part
    // measurements (one per tail part) are read once, for the count of
    // reclaimable tool outputs, straight from `conditions`, so neither copy
    // below carries them.
    #[cfg(test)]
    let meter = phase_meter::start("baseline_without_parts");
    next.tail_hygiene_baseline = conditions
        .baseline
        .map(mc_store::TailHygieneBaseline::clone_without_parts);
    #[cfg(test)]
    drop(meter);
    #[cfg(test)]
    let meter = phase_meter::start("baseline_clone");
    let mut baseline = next.tail_hygiene_baseline.clone();
    #[cfg(test)]
    drop(meter);
    #[cfg(test)]
    let meter = phase_meter::start("grace_decide");
    transform::apply_channel1_compliance_grace(&mut next, &mut baseline, conditions.drops_applied);
    let decision =
        transform::decide_channel1(baseline.as_ref(), &next, conditions.real_user_turn_count);
    #[cfg(test)]
    drop(meter);
    let carrier = conditions
        .newest_tool_tag
        .filter(|tag| Some(*tag) != state.last_tool_tag);
    let mut hints: Option<ReminderHints> = None;
    let mut hints = || -> Result<ReminderHints, String> {
        if hints.is_none() {
            #[cfg(test)]
            let _meter = phase_meter::start("hints");
            hints = Some((conditions.hints)()?);
        }
        Ok(hints.clone().expect("hints computed"))
    };
    if decision.fire && !conditions.drops_applied && carrier.is_some() {
        let selected = match hints() {
            Ok(selected) => selected,
            Err(error) => {
                outcome.hints_failed = Some(error);
                return outcome;
            }
        };
        let kind = if decision.sticky {
            "sticky"
        } else {
            match decision.level {
                transform::Channel1Level::Gentle => "gentle",
                transform::Channel1Level::Firm => "firm",
                transform::Channel1Level::Urgent => "urgent",
            }
        };
        let count = transform::reclaimable_tool_output_count(conditions.baseline);
        let use_ = reduce_use(
            kind,
            decision.reclaimable_tokens,
            count,
            &selected.oldest_reclaimable,
        );
        let modes = delivery_modes(true, &describe);
        if issue(
            runner,
            project_root,
            session,
            conditions.notice_id,
            PreparedSend::reminder("ctx_reduce", use_, conditions.now_ms)
                .naming(&selected.oldest_reclaimable),
            &modes,
            state,
            &mut outcome,
        )
        .await
        {
            transform::commit_channel1_fire(
                &decision,
                &mut next,
                conditions.real_user_turn_count,
                count,
                &[],
            );
            state.last_tool_tag = carrier;
            commit_meta::<FULL_META>(state, next);
        }
    } else {
        if !decision.fire && !conditions.drops_applied {
            transform::apply_channel1_decision_state(&mut next, &decision);
        }
        commit_meta::<FULL_META>(state, next);
        outcome.not_due.push("ctx_reduce_cadence_or_carrier");
    }

    let pressure = baseline
        .as_ref()
        .filter(|b| b.evaluable && !b.generation_invalidated)
        .is_some_and(|b| {
            let (u, t) = crate::tail_hygiene::effective_tail_hygiene(b);
            u >= crate::tail_hygiene::CHANNEL2_FLOOR_TOKENS
                && u as f64 / t.max(1) as f64 >= crate::tail_hygiene::CHANNEL2_SEVERITY_THRESHOLD
        });
    let collapse = conditions.baseline_refreshed
        && baseline.as_ref().is_some_and(|b| {
            b.evaluable
                && !b.generation_invalidated
                && crate::tail_hygiene::effective_tail_hygiene(b).0
                    < crate::tail_hygiene::CHANNEL1_FLOOR_TOKENS
        });
    if conditions.hard_fold_coverage_advanced || collapse {
        state.meta.channel2_pressure_latched = false;
    }
    if pressure && !state.meta.channel2_pressure_latched {
        let selected = match hints() {
            Ok(selected) => selected,
            Err(error) => {
                outcome.hints_failed = Some(error);
                return outcome;
            }
        };
        let (u, _) = crate::tail_hygiene::effective_tail_hygiene(
            baseline.as_ref().expect("evaluable baseline"),
        );
        let use_ = reduce_use(
            "channel2",
            u,
            transform::reclaimable_tool_output_count(conditions.baseline),
            &selected.channel2,
        );
        let modes = delivery_modes(true, &describe);
        if issue(
            runner,
            project_root,
            session,
            conditions.notice_id,
            PreparedSend::reminder("ctx_reduce", use_, conditions.now_ms)
                .naming(&selected.channel2),
            &modes,
            state,
            &mut outcome,
        )
        .await
        {
            state.meta.channel2_pressure_latched = true;
        }
    } else {
        outcome.not_due.push("channel2_pressure_or_latch");
    }

    if let Some(mid) = conditions.user_message_id {
        let marker = conditions
            .temporal_enabled
            .then(|| conditions.gap_ms.and_then(time_use))
            .flatten();
        if let Some(marker) = marker.filter(|_| state.last_time_message.as_deref() != Some(mid)) {
            let modes = delivery_modes(true, &describe);
            if issue(
                runner,
                project_root,
                session,
                conditions.notice_id,
                PreparedSend::reminder("time", marker, conditions.now_ms),
                &modes,
                state,
                &mut outcome,
            )
            .await
            {
                state.last_time_message = Some(mid.into());
            }
        } else {
            outcome.not_due.push("time_disabled_short_gap_or_replay");
        }
        if let Some(hint) = conditions
            .ready_search_hint
            .filter(|hint| !hint.is_empty())
            .filter(|_| state.last_search_message.as_deref() != Some(mid))
        {
            let send = PreparedSend {
                kind: "search_hint",
                template: None,
                shown: Vec::new(),
                prompt: hint.into(),
                sent_at_ms: conditions.now_ms,
                expires_at_ms: conditions.now_ms.saturating_add(REMINDER_TTL_MS),
            };
            let modes = delivery_modes(false, &describe);
            if issue(
                runner,
                project_root,
                session,
                conditions.notice_id,
                send,
                &modes,
                state,
                &mut outcome,
            )
            .await
            {
                state.last_search_message = Some(mid.into());
            }
        } else {
            outcome.not_due.push("search_not_ready_or_replay");
        }
    } else {
        outcome.not_due.push("no_eligible_user_message");
    }
    outcome
}

#[cfg(test)]
mod tests {
    #[test]
    fn broca_session_change_describe_keeps_reminder_delivery_modes() {
        let answer = crate::session_resolver::read_runner_reply(
            crate::broca_session_change_tests::sample("role.describe.session_change.json"),
        )
        .unwrap();
        let describe = cortexkit_role_llm_runner::describe::check_describe(&answer)
            .unwrap_or_else(|problems| panic!("{problems:?}"));
        assert!(describe.declares("delivery_order"));
        for templated in [true, false] {
            assert!(!super::delivery_modes(templated, &describe).is_empty());
        }
    }

    #[test]
    fn broca_session_change_send_goldens_are_accepted_for_reminders() {
        for stem in ["send_reply.admission", "send_reply.session_class"] {
            for suffix in ["before", "after"] {
                let name = format!("send-reply-goldens/{stem}.json.{suffix}");
                let reply = crate::broca_session_change_tests::sample(&name);
                assert!(super::accepted(&reply), "{name}: {reply}");
            }
        }
    }

    use super::*;

    #[test]
    fn ledger_recognition_requires_ordered_write_and_prefers_newest_send() {
        let mut ledger = DeliveryLedger::default();
        for sent_at_ms in [100, 200] {
            let send = PreparedSend {
                kind: "search_hint",
                template: None,
                shown: Vec::new(),
                prompt: "identical text".into(),
                sent_at_ms,
                expires_at_ms: 1000,
            };
            ledger.record(&send, send.prompt.clone());
        }
        assert!(ledger.recognize("identical text", 300, None).is_none());
        assert!(ledger.recognize("identical text", 300, Some(99)).is_none());
        assert_eq!(
            ledger
                .recognize("identical text", 300, Some(250))
                .unwrap()
                .sent_at_ms,
            200
        );
        assert_eq!(
            ledger
                .recognize("identical text", 300, Some(150))
                .unwrap()
                .sent_at_ms,
            100
        );
    }
    use crate::session_resolver::SessionResolveError;
    use std::sync::Mutex;

    #[tokio::test]
    async fn ledger_records_rendered_bytes_kind_time_and_is_bounded_one_shot() {
        let runner = FakeRunner::default();
        let baseline = baseline(30_000, 100_000);
        let conditions = conditions(&baseline);
        let mut state = ReminderState::default();
        let outcome = send_due_reminders(
            &runner,
            Path::new("/test"),
            "reminder-test",
            &mut state,
            &conditions,
        )
        .await;
        assert_eq!(outcome.issued.len(), 3);
        for send in outcome.issued {
            let expected = if send.get("template").is_some() {
                let use_: TemplateUse = serde_json::from_value(send["template"].clone()).unwrap();
                delivery_order::render(&templates(), &use_, test_number).unwrap()
            } else {
                send["prompt"].as_str().unwrap().to_owned()
            };
            let sent = state
                .ledger
                .recognize(&expected, conditions.now_ms, Some(conditions.now_ms))
                .unwrap();
            assert_eq!(format!("mc.{}", sent.kind), send["dedupe_key"]);
            assert_eq!(sent.sent_at_ms, conditions.now_ms);
            assert_eq!(sent.expires_at_ms, conditions.now_ms + REMINDER_TTL_MS);
            assert!(state
                .ledger
                .recognize(&expected, conditions.now_ms, Some(conditions.now_ms))
                .is_none());
        }
        for n in 0..MAX_PENDING_DELIVERIES + 10 {
            state.ledger.record(
                &PreparedSend::reminder("time", time_use(7_260_000).unwrap(), n as u64),
                format!("{n}"),
            );
        }
        assert_eq!(state.ledger.pending.len(), MAX_PENDING_DELIVERIES);
        state
            .ledger
            .expire(REMINDER_TTL_MS + DELIVERY_GRACE_MS + MAX_PENDING_DELIVERIES as u64 + 11);
        assert!(state.ledger.is_empty());
    }

    #[tokio::test]
    async fn ledger_rejects_digest_mismatch_before_sending_and_never_records_refusals() {
        let mut use_ = time_use(7_260_000).unwrap();
        use_.digest = "incorrect".into();
        let runner = FakeRunner::default();
        let mut state = ReminderState::default();
        let mut outcome = ReminderOutcome::default();
        assert!(
            !issue(
                &runner,
                Path::new("/test"),
                "reminder-test",
                "test",
                PreparedSend::reminder("time", use_, 1),
                &DELIVERY,
                &mut state,
                &mut outcome
            )
            .await
        );
        assert!(runner.sends.lock().unwrap().is_empty());
        assert!(state.ledger.is_empty());
        let runner = FakeRunner {
            refuse: true,
            ..Default::default()
        };
        assert!(
            !issue(
                &runner,
                Path::new("/test"),
                "reminder-test",
                "test",
                PreparedSend::reminder("time", time_use(7_260_000).unwrap(), 1),
                &DELIVERY,
                &mut state,
                &mut outcome
            )
            .await
        );
        assert_eq!(runner.sends.lock().unwrap().len(), 1);
        assert!(state.ledger.is_empty());
    }

    #[test]
    fn templates_render_typescript_fixture_bytes() {
        let fixture: Value =
            serde_json::from_str(include_str!("../testdata/runner-reminder-fixture.json")).unwrap();
        let templates = templates();
        assert_eq!(templates.len(), 77);
        let mut covered = std::collections::BTreeSet::new();
        for case in fixture["reduce"].as_array().unwrap() {
            let tags: Vec<u64> = serde_json::from_value(case["tags"].clone()).unwrap();
            let hints = tags.iter().map(|n| hint(*n)).collect::<Vec<_>>();
            let use_ = reduce_use(
                case["kind"].as_str().unwrap(),
                case["tokens"].as_i64().unwrap(),
                case["count"].as_u64().unwrap() as usize,
                &hints,
            );
            let rendered = delivery_order::render(&templates, &use_, |part| {
                test_number(part).filter(|n| tags.contains(n))
            })
            .unwrap();
            assert_eq!(rendered, case["expected"].as_str().unwrap(), "{}", use_.id);
            covered.insert(use_.id);
        }
        for case in fixture["time"].as_array().unwrap() {
            let use_ = time_use(case["gap_ms"].as_i64().unwrap());
            let rendered = use_
                .as_ref()
                .map(|use_| delivery_order::render(&templates, use_, |_| None).unwrap());
            assert_eq!(rendered.as_deref(), case["expected"].as_str());
            if let Some(use_) = use_ {
                covered.insert(use_.id);
            }
        }
        assert_eq!(
            covered.len(),
            templates.len(),
            "every template needs an oracle case"
        );
    }

    #[test]
    fn template_catalog_rejects_string_slots() {
        let catalog = catalog();
        if std::env::var_os("MC_PRINT_REMINDER_CATALOG").is_some() {
            println!("REMINDER_CATALOG={catalog}");
        }
        let plan = json!({"senders":[catalog["sender"].clone()]});
        delivery_order::check_plan(plan.as_object().unwrap(), &["delivery_order"]).unwrap();
        let senders = delivery_order::plan_senders(plan.as_object().unwrap()).unwrap();
        assert!(!senders[0].idle_start);
        for template in &senders[0].templates {
            let published = catalog["templates"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["id"] == template.id)
                .unwrap();
            assert_eq!(
                published["digest"],
                delivery_order::template_digest(template)
            );
            for slot in template.slots.values() {
                assert!(matches!(
                    slot,
                    Slot::Integer { .. } | Slot::Percentage | Slot::PartTag | Slot::Enum { .. }
                ));
            }
        }
        let use_ = reduce_use("gentle", 30_000, 7, &[hint(12)]);
        let mut string_value = use_.clone();
        string_value.slots.insert("tokens_k".into(), json!("30"));
        assert!(delivery_order::render(&templates(), &string_value, test_number).is_err());
        // A tag slot carries the part's identity, never a number: a number in
        // the slot does not render.
        let mut number_value = use_.clone();
        number_value.slots.insert("tag0".into(), json!("§12§"));
        assert!(delivery_order::render(&templates(), &number_value, test_number).is_err());
        assert!(
            delivery_order::render(&templates(), &use_, |_| None).is_err(),
            "a part the request does not show must not render"
        );
    }

    #[test]
    fn integer_slots_are_json_safe_and_senders_clamp_large_values() {
        for template in templates() {
            for (name, slot) in template.slots {
                if let Slot::Integer { max, .. } = slot {
                    assert_eq!(max, if name == "minor" { 59 } else { 100_000 });
                }
            }
        }
        let reduction = reduce_use("urgent", i64::MAX, usize::MAX, &[hint(12)]);
        assert_eq!(reduction.slots["tokens_k"], 100_000);
        assert_eq!(reduction.slots["count"], 100_000);
        delivery_order::render(&templates(), &reduction, test_number).unwrap();
        let time = time_use(i64::MAX).unwrap();
        assert_eq!(time.slots["major"], 100_000);
        if let Some(minor) = time.slots.get("minor") {
            assert!(minor
                .as_i64()
                .is_some_and(|minor| (1..=59).contains(&minor)));
        }
        delivery_order::render(&templates(), &time, |_| None).unwrap();
    }

    #[test]
    fn template_catalog_matches_pinned_digests() {
        let pinned: Value =
            serde_json::from_str(include_str!("../testdata/runner-reminder-catalog.json")).unwrap();
        let actual = Value::Object(
            catalog()["templates"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| {
                    (
                        row["id"].as_str().unwrap().to_owned(),
                        row["digest"].clone(),
                    )
                })
                .collect(),
        );
        assert_eq!(actual, pinned);
    }

    #[derive(Default)]
    struct FakeRunner {
        sends: Mutex<Vec<Value>>,
        describe_calls: Mutex<usize>,
        delivery_modes: Mutex<Option<Vec<String>>>,
        description_version: Mutex<Option<String>>,
        missing_capability: bool,
        refuse: bool,
        delivery_unsupported: bool,
    }

    #[subc_client_rs::async_trait]
    impl ProviderRunner for FakeRunner {
        async fn call_for_identity(
            &self,
            _: &crate::route_targets::SessionRunnerRoute,
            identity: &crate::session_resolver::RunnerBindIdentity,
            method: &str,
            params: Value,
            budget: Duration,
        ) -> Result<Value, SessionResolveError> {
            self.call(
                &identity.project_root,
                &identity.session,
                method,
                params,
                budget,
            )
            .await
        }

        async fn call(
            &self,
            _: &Path,
            session: &str,
            method: &str,
            params: Value,
            _: Duration,
        ) -> Result<Value, SessionResolveError> {
            assert_eq!(session, "reminder-test");
            match method {
                "role.describe" => {
                    *self.describe_calls.lock().unwrap() += 1;
                    let modes = self.delivery_modes.lock().unwrap().clone();
                    let mut capabilities = vec!["delivery_order"];
                    if modes
                        .as_ref()
                        .is_some_and(|modes| modes.iter().any(|mode| mode == "steer"))
                    {
                        capabilities.push("steer");
                    }
                    if modes
                        .as_ref()
                        .is_some_and(|modes| modes.iter().any(|mode| mode == "idle_start"))
                    {
                        capabilities.push("queue");
                    }
                    let version = self
                        .description_version
                        .lock()
                        .unwrap()
                        .clone()
                        .unwrap_or_else(|| "fake".into());
                    let mut description = json!({
                        "majors":[{"version":"llm-runner/v1","ops":["role.describe","session.baseline","session.send"]}],
                        "implementation_version":version, "session_capabilities_from":"baseline",
                        "capabilities":if self.missing_capability {vec![]} else {capabilities}
                    });
                    if let Some(modes) = modes {
                        description["delivery_order_modes"] = json!(modes);
                    }
                    Ok(description)
                }
                "session.send" => {
                    let request: SendRequest = serde_json::from_value(params.clone()).unwrap();
                    request.check_delivery_order(&["delivery_order"]).unwrap();
                    let order = request.delivery_order().unwrap().unwrap();
                    if let Some(template) = order.template {
                        delivery_order::render(&templates(), &template, test_number).unwrap();
                    }
                    self.sends.lock().unwrap().push(params);
                    if self.delivery_unsupported {
                        return Ok(json!({
                            "error": {
                                "code": "delivery_unsupported",
                                "detail": {"delivery": order.modes}
                            }
                        }));
                    }
                    if self.refuse {
                        Ok(json!({"error":{"code":"invalid_params"}}))
                    } else {
                        Ok(json!({"state":"pending","submission_id":"q"}))
                    }
                }
                _ => panic!("unexpected callback {method}"),
            }
        }
    }

    /// A hint naming part `p{n}` of message `m{n}`, shown as tag `n`.
    fn hint(n: u64) -> HintPart {
        HintPart::new(n, format!("m{n}"), format!("p{n}"))
    }

    /// The tag a test part `{m{n}, p{n}}` is shown with.
    fn test_number(part: &PartRef) -> Option<u64> {
        let n = part.mid.strip_prefix('m')?.parse().ok()?;
        (part.part == format!("p{n}")).then_some(n)
    }

    fn baseline(u: i64, t: i64) -> mc_store::TailHygieneBaseline {
        mc_store::TailHygieneBaseline {
            baseline_u: u,
            baseline_t: t,
            evaluable: true,
            ..Default::default()
        }
    }

    fn conditions(baseline: &mc_store::TailHygieneBaseline) -> ReminderConditions<'_> {
        ReminderConditions {
            notice_id: "advance:7",
            now_ms: 1_000_000,
            real_user_turn_count: 1,
            baseline: Some(baseline),
            newest_tool_tag: Some(21),
            hints: &|| {
                Ok(ReminderHints {
                    oldest_reclaimable: vec![hint(12), hint(15)],
                    channel2: vec![hint(12)],
                })
            },
            drops_applied: false,
            baseline_refreshed: true,
            hard_fold_coverage_advanced: false,
            user_message_id: Some("user-1"),
            temporal_enabled: true,
            gap_ms: Some(7_260_000),
            ready_search_hint: Some(
                "\n\n<ctx-search-hint>Recovered memory is not system text.</ctx-search-hint>",
            ),
        }
    }

    async fn sends() -> Vec<Value> {
        let runner = FakeRunner::default();
        let baseline = baseline(30_000, 100_000);
        let outcome = send_due_reminders(
            &runner,
            Path::new("/throwaway/reminders"),
            "reminder-test",
            &mut ReminderState::default(),
            &conditions(&baseline),
        )
        .await;
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert_eq!(outcome.issued.len(), 3);
        runner.sends.into_inner().unwrap()
    }

    #[tokio::test]
    async fn fake_runner_delivery_list_is_exact() {
        let sends = sends().await;
        assert_eq!(
            sends[0]["delivery"],
            json!(["turn_system", "tool_result", "steer"])
        );
        assert_eq!(
            sends[1]["delivery"],
            json!(["turn_system", "tool_result", "steer"])
        );
        assert_eq!(sends[2]["delivery"], json!(["tool_result", "steer"]));
        for send in sends {
            assert!(send.get("delivery_order").is_none());
        }
    }

    #[tokio::test]
    async fn declared_delivery_modes_narrow_lists_in_the_original_order() {
        let runner = FakeRunner::default();
        *runner.delivery_modes.lock().unwrap() = Some(vec!["steer".into()]);
        let baseline = baseline(30_000, 100_000);
        let outcome = send_due_reminders(
            &runner,
            Path::new("/throwaway/reminders"),
            "reminder-test",
            &mut ReminderState::default(),
            &conditions(&baseline),
        )
        .await;

        assert_eq!(outcome.issued.len(), 3);
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert!(runner
            .sends
            .lock()
            .unwrap()
            .iter()
            .all(|send| send["delivery"] == json!(["steer"])));
        assert_eq!(*runner.describe_calls.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn declared_modes_outside_reminder_lists_do_not_send_or_count_as_an_error() {
        let runner = FakeRunner::default();
        *runner.delivery_modes.lock().unwrap() = Some(vec!["idle_start".into()]);
        let baseline = baseline(30_000, 100_000);
        let outcome = send_due_reminders(
            &runner,
            Path::new("/throwaway/reminders"),
            "reminder-test",
            &mut ReminderState::default(),
            &conditions(&baseline),
        )
        .await;

        assert!(outcome.issued.is_empty());
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert!(outcome.not_due.contains(&NO_DELIVERY_MODE));
        assert!(runner.sends.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn delivery_unsupported_is_remembered_per_list_across_restart_until_description_changes()
    {
        let runner = FakeRunner {
            delivery_unsupported: true,
            ..Default::default()
        };
        let root = Path::new("/throwaway/reminders");
        let baseline = baseline(30_000, 100_000);
        let conditions = conditions(&baseline);
        let mut state = ReminderState::default();
        let first =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        assert_eq!(first.errors.len(), 2);
        let initial_sends = runner.sends.lock().unwrap().clone();
        assert_eq!(initial_sends.len(), 2);
        assert_eq!(
            initial_sends[0]["delivery"],
            json!(["turn_system", "tool_result", "steer"])
        );
        assert_eq!(
            initial_sends[1]["delivery"],
            json!(["tool_result", "steer"])
        );

        let saved = serde_json::to_value(&state).unwrap();
        let mut restarted_state: ReminderState = serde_json::from_value(saved).unwrap();
        let second = send_due_reminders(
            &runner,
            root,
            "reminder-test",
            &mut restarted_state,
            &conditions,
        )
        .await;
        assert!(second.errors.is_empty(), "{:?}", second.errors);
        assert!(second.not_due.contains(&REFUSED_DELIVERY));
        assert_eq!(runner.sends.lock().unwrap().len(), initial_sends.len());

        *runner.description_version.lock().unwrap() = Some("fake-reconnected".into());
        let third = send_due_reminders(
            &runner,
            root,
            "reminder-test",
            &mut restarted_state,
            &conditions,
        )
        .await;
        assert_eq!(third.errors.len(), 2);
        assert_eq!(runner.sends.lock().unwrap().len(), initial_sends.len() * 2);
        assert_eq!(*runner.describe_calls.lock().unwrap(), 3);
    }

    #[test]
    fn old_reminder_state_without_refusal_memory_deserializes() {
        let mut old_state = serde_json::to_value(ReminderState::default()).unwrap();
        old_state
            .as_object_mut()
            .unwrap()
            .remove("delivery_refusals");
        let decoded: ReminderState = serde_json::from_value(old_state).unwrap();
        assert!(decoded.delivery_refusals.runner_description.is_none());
        assert!(decoded.delivery_refusals.lists.is_empty());
    }

    /// Reminder-mode reset on describe change: the stored raw describe is
    /// compared whole, so the two new 0.7 groups clear remembered refusals
    /// while the descriptor itself still decodes and still promises delivery.
    #[test]
    fn broca_0_7_describe_change_resets_reminder_refusals() {
        use cortexkit_role_llm_runner::describe::check_describe;
        let before: Value = serde_json::from_slice(include_bytes!(
            "../testdata/broca-0.7/role.describe.before.json"
        ))
        .unwrap();
        let after: Value = serde_json::from_slice(include_bytes!(
            "../testdata/broca-0.7/role.describe.after.json"
        ))
        .unwrap();
        let before_answer =
            crate::session_resolver::read_runner_reply(before).expect("before envelope");
        let after_answer =
            crate::session_resolver::read_runner_reply(after).expect("after envelope");
        for answer in [&before_answer, &after_answer] {
            let describe = check_describe(answer).unwrap_or_else(|problems| panic!("{problems:?}"));
            assert!(describe.declares("delivery_order"));
        }
        let mut refusals = DeliveryRefusals::default();
        refusals.use_description(&before_answer);
        refusals.record(&[Mode::ToolResult]);
        assert!(refusals.contains(&[Mode::ToolResult]));
        // The same describe keeps remembered refusals.
        refusals.use_description(&before_answer);
        assert!(refusals.contains(&[Mode::ToolResult]));
        // The 0.7 describe differs only by additive groups, yet the whole
        // stored description changed, so the mode lists are cleared.
        refusals.use_description(&after_answer);
        assert!(!refusals.contains(&[Mode::ToolResult]));
    }

    #[tokio::test]
    async fn fake_runner_requires_dedupe_per_kind() {
        let sends = sends().await;
        assert_eq!(sends[0]["dedupe_key"], "mc.ctx_reduce");
        assert_eq!(sends[1]["dedupe_key"], "mc.time");
        assert_eq!(sends[2]["dedupe_key"], "mc.search_hint");
    }

    #[tokio::test]
    async fn fake_runner_receives_templates_slots_expiry_and_user_search() {
        let sends = sends().await;
        assert_eq!(
            sends[0]["template"]["id"],
            "mc.ctx_reduce.gentle.zero.h2.v1"
        );
        assert_eq!(
            sends[0]["template"]["slots"],
            json!({"tokens_k":30,"tag0":{"mid":"m12","part":"p12"},"tag1":{"mid":"m15","part":"p15"}})
        );
        assert_eq!(sends[1]["template"]["id"], "mc.time.compound.v1");
        assert_eq!(
            sends[1]["template"]["slots"],
            json!({"major":2,"major_unit":"h","minor":1,"minor_unit":"m"})
        );
        assert!(sends[0].get("prompt").is_none());
        assert!(sends[1].get("prompt").is_none());
        assert!(sends[2].get("template").is_none());
        assert!(sends[2]["prompt"]
            .as_str()
            .unwrap()
            .contains("Recovered memory"));
        for send in sends {
            assert_eq!(send["expires_at_ms"], 1_300_000);
            assert!(!send["send_id"].as_str().unwrap().is_empty());
            if let Some(template) = send.get("template") {
                let use_: TemplateUse = serde_json::from_value(template.clone()).unwrap();
                delivery_order::render(&templates(), &use_, test_number).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn reminder_cadence_grace_replay_and_capability_guards() {
        let runner = FakeRunner::default();
        let root = Path::new("/throwaway/reminders");
        let baseline = baseline(30_000, 100_000);
        let mut conditions = conditions(&baseline);
        let mut state = ReminderState::default();
        let first =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        assert_eq!(first.issued.len(), 3);
        let replay =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        assert!(replay.issued.is_empty());
        conditions.real_user_turn_count = 6;
        conditions.newest_tool_tag = Some(22);
        let grown = self::baseline(60_000, 110_000);
        conditions.baseline = Some(&grown);
        let firm =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        assert_eq!(
            firm.issued[0]["template"]["id"],
            "mc.ctx_reduce.firm.zero.h2.v1"
        );
        conditions.drops_applied = true;
        conditions.newest_tool_tag = Some(23);
        let applied =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        assert!(applied.issued.is_empty());
        let unsupported = FakeRunner {
            missing_capability: true,
            ..Default::default()
        };
        let no_cap = send_due_reminders(
            &unsupported,
            root,
            "reminder-test",
            &mut ReminderState::default(),
            &conditions,
        )
        .await;
        assert_eq!(no_cap.not_due, ["runner_missing_delivery_order"]);
        assert!(unsupported.sends.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn runner_refusal_does_not_consume_cadence_and_retry_ids_are_stable() {
        let runner = FakeRunner {
            refuse: true,
            ..Default::default()
        };
        let root = Path::new("/throwaway/reminders");
        let baseline = baseline(30_000, 100_000);
        let conditions = conditions(&baseline);
        let mut state = ReminderState::default();
        let first =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        let second =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        assert_eq!(first.errors.len(), 3);
        assert_eq!(second.errors.len(), 3);
        assert_eq!(state.meta.channel1_last_fire_ordinal, 0);
        let attempts = runner.sends.lock().unwrap();
        assert_eq!(&attempts[..3], &attempts[3..]);
    }

    #[tokio::test]
    async fn sticky_repeat_keeps_regrowth_and_five_user_turn_guards() {
        let runner = FakeRunner::default();
        let root = Path::new("/throwaway/reminders");
        let initial = baseline(40_000, 200_000);
        let mut conditions = conditions(&initial);
        conditions.user_message_id = None;
        let mut state = ReminderState::default();
        assert_eq!(
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions)
                .await
                .issued
                .len(),
            1
        );
        let grown = baseline(65_000, 200_000);
        conditions.baseline = Some(&grown);
        conditions.newest_tool_tag = Some(22);
        conditions.real_user_turn_count = 5;
        assert!(
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions)
                .await
                .issued
                .is_empty()
        );
        conditions.real_user_turn_count = 6;
        let repeated =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        assert_eq!(repeated.issued.len(), 1);
        assert_eq!(
            repeated.issued[0]["template"]["id"],
            "mc.ctx_reduce.sticky.zero.h2.v1"
        );
    }

    #[tokio::test]
    async fn channel2_latch_rearms_on_measured_collapse_or_coverage_advance() {
        let runner = FakeRunner::default();
        let root = Path::new("/throwaway/reminders");
        let pressure = baseline(80_000, 100_000);
        let mut conditions = conditions(&pressure);
        conditions.user_message_id = None;
        conditions.newest_tool_tag = None;
        let mut state = ReminderState::default();
        let first =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        assert_eq!(first.issued.len(), 1);
        assert_eq!(
            first.issued[0]["template"]["id"],
            "mc.ctx_reduce.channel2.zero.h1.v1"
        );
        let lower = baseline(40_000, 100_000);
        conditions.baseline = Some(&lower);
        assert!(
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions)
                .await
                .issued
                .is_empty()
        );
        conditions.baseline = Some(&pressure);
        assert!(
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions)
                .await
                .issued
                .is_empty()
        );
        let collapse = baseline(20_000, 100_000);
        conditions.baseline = Some(&collapse);
        send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        conditions.baseline = Some(&pressure);
        assert_eq!(
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions)
                .await
                .issued
                .len(),
            1
        );
        conditions.hard_fold_coverage_advanced = true;
        assert_eq!(
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions)
                .await
                .issued
                .len(),
            1
        );
    }

    #[test]
    fn unknown_or_refused_send_reply_is_not_acceptance() {
        assert!(!accepted(&json!({})));
        assert!(!accepted(&json!({"state":"future_unknown_state"})));
        assert!(!accepted(&json!({"error":{"code":"invalid_params"}})));
        assert!(accepted(&json!({"state":"pending","submission_id":"q"})));
    }
}
