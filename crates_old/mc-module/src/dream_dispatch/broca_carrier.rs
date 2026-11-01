//! Dream children run as Broca sessions. Every admission decision (an explicitly
//! configured Broca runner, an exact model, the runner's described capabilities,
//! retention and the input-token cap) is made before a prompt leaves Rust.
//!
//! Broca dispatches each tool call of the child to a module: file tools to AFT,
//! memory tools back to Magic Context. A memory tool call reaches the task's
//! `TaskToolRouter` only through [`BrocaToolRoute`], which resolves the child from
//! the daemon-bound session of the calling route and this module's own record,
//! never from model arguments. Broca enforces the frozen allowlist and the step
//! limit (`stop_when`) itself; Magic Context rechecks the allowlist, live task
//! control and the token budget before every memory effect. Path fencing of file
//! tools is AFT's, not Broca's or this carrier's.

use super::context::{ChildEvent, ChildObserver, TaskContext, TaskToolRouter, ToolError};
use super::domain_control::available;
use crate::child_retention::{self, child_policy, ChildRetention, ReleaseOutcome, RetentionMember};
use crate::dream_runner::{CarrierError, ChildRequest, Completion, DreamCarrier, Usage};
use crate::historian_runner::{HistorianRunnerKind, RunnerSource};
use crate::McHandler;
use cortexkit_role_llm_runner::describe::{check_describe, RoleDescribe};
use cortexkit_role_llm_runner::retract::RetractReply;
use cortexkit_role_llm_runner::run::{cancel_at, RunCancelReply, RunResult, RunState};
use cortexkit_role_llm_runner::send::{Budget, SendReply, SendRequest, SendState};
use cortexkit_role_llm_runner::{capabilities as caps, ops};
use cortexkit_role_tool_provider::errors as tool_errors;
use mc_store::dream_scheduler::budget::{BudgetAction, TokenBudget};
use mc_store::dream_scheduler::SqliteDreamScheduler;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use subc_client_rs::HandlerOutcome;

/// Every Broca dream session id starts with this prefix. A route bound to such a
/// session never reaches the foreground memory facade, even after its child is
/// gone, so a late or replayed call from a finished run cannot gain foreground
/// authority.
pub const SESSION_PREFIX: &str = "mc-dream-";
/// The tools Magic Context itself serves to a dream child. Every other admitted
/// tool is a file tool served (and path-fenced) by AFT.
pub const MC_TOOLS: &[&str] = &["ctx_memory", "ctx_search"];
/// The module that serves file tools to a Broca child.
pub const FILE_TOOL_PROVIDER: &str = "aft";
/// Retention for an ordinary dream session on a runner with only the older
/// `retention` group: one day, as for historian sessions.
pub const ORDINARY_RETENTION_SECONDS: u64 = 86_400;
/// A privacy-sensitive dream needs deletion of all runner-held content within an
/// hour of its retention expiring; a runner promising less is unavailable.
pub const PRIVATE_DELETE_WITHIN_MS: u64 = 3_600_000;
/// Slack added to a privacy-sensitive session's retention past its attempt
/// timeout, so cancellation and quiescence checks still find the session.
pub const PRIVATE_RETENTION_SLACK_SECONDS: u64 = 60;
const MAX_BODY: usize = 1024 * 1024;
const MAX_CALLS: usize = 4096;
const SEND_ATTEMPTS: usize = 3;
const CLEANUP_MS: u64 = 2_000;
const POLL_MS: u64 = 5;

fn error(message: impl Into<String>) -> CarrierError {
    CarrierError {
        message: message.into(),
        retryable: false,
    }
}

fn secret() -> Result<String, CarrierError> {
    let mut bytes = [0_u8; 32];
    // Without OS entropy the session id would be guessable; refuse instead.
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| error(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// A failed llm-runner op. `outcome_unknown` means the request may have reached
/// the runner and taken effect while its reply was lost.
#[derive(Debug, Clone, PartialEq)]
pub struct PortError {
    pub code: String,
    pub message: String,
    pub detail: Value,
    pub outcome_unknown: bool,
}

/// The llm-runner/v1 wire of one Broca module, as seen from Magic Context.
/// Implementations carry each op on a route bound to `session`; the bound route,
/// never a request field, names the session an op acts on.
#[allow(async_fn_in_trait)]
pub trait BrocaPort {
    /// One unary op (`role.describe`, `session.send`, `run.status`, `run.result`, `run.cancel`,
    /// `session.retract`, `session.release`) with its role params; answers the reply body as sent,
    /// envelope included (the carrier reads the envelope, strictly).
    async fn call(&mut self, session: &str, op: &str, params: Value) -> Result<Value, PortError>;
    /// The next unit of the session's `session.subscribe` stream from its start,
    /// or `None` when no unit is ready yet.
    async fn next_unit(&mut self, session: &str) -> Result<Option<Value>, PortError>;
    /// Release the session's routes. This is never a deletion: a child sent
    /// `retention_policy` was already released through `session.release`, and
    /// any other child lives as long as the retention its first send fixed.
    async fn release(&mut self, session: &str);
    /// Returns the parent session for a runner-lane conversation when this port uses
    /// that conversation's runner instead of the configured Broca module. The carrier
    /// uses it to reject child requests scoped to a different parent while keeping
    /// each child route bound to its own session.
    fn session_runner_parent(&self) -> Option<&str> {
        None
    }
}

/// Task-level choices the executor makes once, with the trusted task context.
#[derive(Debug, Clone)]
pub struct BrocaPolicy {
    /// Magic Context's own module id, named as the provider of its plan item.
    pub module_id: String,
    /// The task needs a runner-enforced input-token cap: a runner that does not
    /// advertise `input_token_cap` is unavailable rather than merely stopped late.
    pub require_hard_cap: bool,
    /// The prompt carries private memory: use the shortest retention and require
    /// deletion within [`PRIVATE_DELETE_WITHIN_MS`] of expiry.
    pub privacy_sensitive: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Refusal {
    code: &'static str,
    message: String,
}

fn refusal(code: &'static str, message: impl Into<String>) -> Refusal {
    Refusal {
        code,
        message: message.into(),
    }
}

struct Entry {
    context: Arc<TaskContext>,
    allowed: Vec<&'static str>,
    router: Arc<dyn TaskToolRouter>,
    observer: Arc<dyn ChildObserver>,
    budget: Option<TokenBudget>,
    /// Responses by the runner's `call_key`, success or refusal, so a call the
    /// runner dispatches again is answered from here and never executes twice.
    calls: HashMap<String, (Value, Result<Value, Refusal>)>,
    call_bytes: usize,
    started: bool,
    stop: bool,
}

impl Entry {
    fn live(&mut self) -> Result<(), Refusal> {
        if self.stop {
            return Err(refusal(
                tool_errors::TOOL_UNAVAILABLE,
                "dream_child_stopped",
            ));
        }
        if !self.started {
            return Err(refusal(
                tool_errors::TOOL_UNAVAILABLE,
                "dream_child_not_running",
            ));
        }
        if let Err(e) = self.context.check_control() {
            self.stop = true;
            return Err(refusal(tool_errors::TOOL_UNAVAILABLE, format!("{e:?}")));
        }
        Ok(())
    }

    fn admit(&mut self, tool: &str) -> Result<(), Refusal> {
        if !self.allowed.contains(&tool) {
            return Err(refusal(
                tool_errors::CAPABILITY_NOT_ADMITTED,
                format!("tool_not_admitted: {tool}"),
            ));
        }
        let task_refused = self
            .context
            .control
            .refuse_tool()
            .map_err(|e| refusal(tool_errors::TOOL_UNAVAILABLE, format!("{e:?}")))?;
        if task_refused.is_some()
            || self
                .budget
                .as_mut()
                .is_some_and(|b| b.refuse_tool().is_some())
        {
            return Err(refusal(tool_errors::TOOL_UNAVAILABLE, "budget_exhausted"));
        }
        Ok(())
    }
}

/// The dream children this process started on Broca, each keyed by the Broca
/// session it runs in. A memory tool call is executed only for a session found
/// here, and the record lives in memory only: after a restart it is empty, so a
/// Broca run started by the previous process can no longer call a memory tool.
#[derive(Default)]
pub struct BrocaToolRoute {
    entries: Mutex<HashMap<String, Entry>>,
}

impl BrocaToolRoute {
    fn insert(&self, session: &str, entry: Entry) -> Result<(), CarrierError> {
        let mut entries = self.entries.lock().map_err(|_| error("route_poisoned"))?;
        if entries.contains_key(session) {
            return Err(error("session_reused"));
        }
        entries.insert(session.into(), entry);
        Ok(())
    }

    fn update<R>(&self, session: &str, f: impl FnOnce(&mut Entry) -> R) -> Option<R> {
        self.entries.lock().ok()?.get_mut(session).map(f)
    }

    fn remove(&self, session: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(session);
        }
    }

    /// Whether this record still holds a live child for `session`.
    pub fn is_live(&self, session: &str) -> bool {
        self.entries
            .lock()
            .is_ok_and(|entries| entries.get(session).is_some_and(|e| !e.stop))
    }

    /// Execute one tool-provider call that the runner dispatched on a route bound
    /// to `session` in `project`. Name, arguments and `call_key` come from the
    /// request; the child, its task, router and limits come from this record.
    pub(crate) fn call(
        &self,
        session: &str,
        project: &Path,
        request: &Value,
    ) -> Result<Value, Refusal> {
        if request.to_string().len() > MAX_BODY {
            return Err(refusal(tool_errors::INVALID_REQUEST, "body_too_large"));
        }
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| refusal(tool_errors::TOOL_UNAVAILABLE, "route_poisoned"))?;
        let e = entries
            .get_mut(session)
            .ok_or_else(|| refusal(tool_errors::TOOL_UNAVAILABLE, "dream_child_closed"))?;
        let same_project = Path::new(&e.context.scope.project.0) == project
            || project.canonicalize().ok().as_deref()
                == Some(Path::new(&e.context.scope.project.0));
        if !same_project {
            return Err(refusal(tool_errors::TOOL_UNAVAILABLE, "project_mismatch"));
        }
        let tool = request
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| refusal(tool_errors::INVALID_REQUEST, "name"))?;
        let arguments = request
            .get("arguments")
            .ok_or_else(|| refusal(tool_errors::INVALID_REQUEST, "arguments"))?;
        // The runner's call_key (`<lineage>:<wal_seq>` on Broca) is the only replay
        // identity; a call without one could not be told apart from a re-dispatch.
        let key = request
            .get("call_key")
            .and_then(Value::as_str)
            .filter(|k| subc_protocol::tool_call::validate_call_key(k).is_ok())
            .ok_or_else(|| refusal(tool_errors::INVALID_REQUEST, "call_key"))?;
        let input = json!({"name": tool, "arguments": arguments});
        if let Some((previous, answer)) = e.calls.get(key) {
            return if previous == &input {
                answer.clone()
            } else {
                Err(refusal(tool_errors::INVALID_REQUEST, "call_conflict"))
            };
        }
        let bytes = input.to_string().len();
        if e.calls.len() >= MAX_CALLS || e.call_bytes + bytes > 4 * MAX_BODY {
            return Err(refusal(tool_errors::TOOL_UNAVAILABLE, "too_many_calls"));
        }
        let admitted = e.live().and_then(|()| e.admit(tool));
        let answer = match admitted {
            Ok(()) => e
                .router
                .execute(session, tool, arguments)
                .map_err(|err| match err {
                    ToolError::InvalidArguments(m) => refusal(tool_errors::INVALID_REQUEST, m),
                    ToolError::NotAdmitted(m) => refusal(tool_errors::CAPABILITY_NOT_ADMITTED, m),
                    other => refusal(tool_errors::TOOL_UNAVAILABLE, format!("{other:?}")),
                }),
            Err(r) => Err(r),
        };
        let (answer, receipt) = match answer {
            Ok(result) => {
                let body = json!({"ok": true, "output": result.output,
                    "receipt": result.receipt.as_ref().map(|r| json!({"tool": r.tool, "affected_ids": r.affected_ids, "details": r.details}))});
                if body.to_string().len() > MAX_BODY {
                    e.stop = true;
                    (
                        Err(refusal(
                            tool_errors::TOOL_UNAVAILABLE,
                            "tool_output_too_large: effect_may_have_applied",
                        )),
                        None,
                    )
                } else {
                    (Ok(body), result.receipt)
                }
            }
            Err(r) => (Err(r), None),
        };
        // Cache before observing: an observer failure must never replay an effect.
        e.call_bytes += bytes;
        e.calls.insert(key.into(), (input, answer.clone()));
        if let Some(receipt) = receipt {
            if let Err(err) = e.observer.observe(session, ChildEvent::Receipt(receipt)) {
                e.stop = true;
                return Err(refusal(
                    tool_errors::TOOL_UNAVAILABLE,
                    format!("observer_failed: {err:?}"),
                ));
            }
        }
        answer
    }
}

impl McHandler {
    /// Off-thread executors give this record to every [`BrocaCarrier`] they build,
    /// so the runner's memory tool calls resolve to the carrier's task router.
    pub fn broca_dream_tools(&self) -> Arc<BrocaToolRoute> {
        self.broca_dream_tools.clone()
    }

    /// Requests on a route bound to a Broca dream session. Read-only discovery
    /// (`tool.catalog`, `role.describe`) keeps its ordinary handler; any other
    /// request is a dream tool call or is refused. `None` for every other route.
    pub(crate) fn broca_dream_route(
        &self,
        channel: u16,
        method: Option<&str>,
        request: &Value,
    ) -> Option<HandlerOutcome> {
        let binding = self.facade_binding(channel).ok()?;
        if !binding.session.starts_with(SESSION_PREFIX) {
            return None;
        }
        let name = request.get("name").and_then(Value::as_str);
        let discovery = match method {
            Some(method) => method == cortexkit_role_tool_provider::ops::ROLE_DESCRIBE,
            None => matches!(
                name,
                Some(
                    cortexkit_role_tool_provider::ops::TOOL_CATALOG
                        | cortexkit_role_tool_provider::ops::ROLE_DESCRIBE
                )
            ),
        };
        if discovery {
            return None;
        }
        if method.is_some() || name.is_none() || request.get("arguments").is_none() {
            return Some(HandlerOutcome::Error {
                code: tool_errors::INVALID_REQUEST.into(),
                message: "a dream session route serves only its child's tool calls".into(),
            });
        }
        Some(
            match self
                .broca_dream_tools
                .call(&binding.session, &binding.project_root, request)
            {
                Ok(body) => crate::respond(body),
                Err(r) => HandlerOutcome::Error {
                    code: r.code.into(),
                    message: r.message,
                },
            },
        )
    }
}

fn port_error(op: &str, e: PortError) -> CarrierError {
    error(format!("{op}: {}: {}", e.code, e.message))
}

/// The answer inside the reply to llm-runner op `op`. Every llm-runner reply
/// is exactly `{"result": <answer>}`; any other shape is refused as
/// `runner_reply_shape` by `session_resolver::read_runner_reply`, the one
/// decoder of that envelope, and never read either way.
fn reply_answer(op: &str, reply: Value) -> Result<Value, CarrierError> {
    crate::session_resolver::read_runner_reply(reply)
        .map_err(|shape| error(format!("{op}: {shape}")))
}

struct Attempt {
    session: String,
    send: Value,
    cancel_at: Option<&'static str>,
    can_retract: bool,
    /// A `session.send` may have reached the runner.
    sent: bool,
    /// The runner refused the send, which writes nothing.
    refused: bool,
    run_id: Option<String>,
    submission: Option<String>,
    terminal: Option<RunResult>,
    cancel_sent: bool,
    stop_reason: Option<String>,
    total: Usage,
    final_observed: bool,
    reports_usage: bool,
    /// The child was sent `retention_policy`, so it is released on close.
    release: bool,
}

/// One dream attempt per open, each in a fresh Broca session whose id is minted
/// here and never shown to the model. `complete` sends the prompt exactly once
/// (a lost reply is retried with the same `send_id` and bytes, which the runner
/// deduplicates). `close` stops memory tools at once, cancels the run at a step
/// boundary or retracts a queued send, and succeeds only once `run.result`
/// reports a terminal state.
pub struct BrocaCarrier<P: BrocaPort> {
    port: P,
    routes: Arc<BrocaToolRoute>,
    context: Arc<TaskContext>,
    router: Arc<dyn TaskToolRouter>,
    observer: Arc<dyn ChildObserver>,
    scheduler: Arc<SqliteDreamScheduler>,
    policy: BrocaPolicy,
    attempt: Option<Attempt>,
}

impl<P: BrocaPort> BrocaCarrier<P> {
    pub fn new(
        port: P,
        routes: Arc<BrocaToolRoute>,
        context: Arc<TaskContext>,
        router: Arc<dyn TaskToolRouter>,
        observer: Arc<dyn ChildObserver>,
        scheduler: Arc<SqliteDreamScheduler>,
        policy: BrocaPolicy,
    ) -> Self {
        Self {
            port,
            routes,
            context,
            router,
            observer,
            scheduler,
            policy,
            attempt: None,
        }
    }

    pub fn port(&self) -> &P {
        &self.port
    }

    fn attempt(&mut self, child: &str) -> Result<&mut Attempt, CarrierError> {
        self.attempt
            .as_mut()
            .filter(|a| a.session == child)
            .ok_or_else(|| error("child_mismatch"))
    }

    /// Admission, in order, before the runner sees anything but `role.describe`.
    fn admit(&self, request: &ChildRequest) -> Result<(String, String, Option<u64>), CarrierError> {
        self.context
            .check_control()
            .map_err(|e| error(format!("{e:?}")))?;
        // Broca runs dream work only when the user chose it; a harness default
        // never moves work off the host. A runner-lane conversation's own runner is
        // that host, so a port to it needs no configured Broca runner.
        let session_parent = self.port.session_runner_parent();
        if session_parent.is_none()
            && (request.runner.kind != HistorianRunnerKind::Broca
                || request.runner.source != RunnerSource::Configured)
        {
            return Err(error("unavailable: broca_not_configured"));
        }
        let model = request
            .model
            .as_ref()
            .ok_or_else(|| error("unavailable: model_required"))?;
        let (provider, name) = model
            .model
            .split_once('/')
            .filter(|(p, m)| !p.is_empty() && !m.is_empty())
            .ok_or_else(|| error("invalid_model"))?;
        if request.prompt.len() + request.system.len() > MAX_BODY
            || request.parent_session_id != self.context.scope.session.0
            || session_parent.is_some_and(|parent| parent != request.parent_session_id)
            || request.directory != self.context.config.directory
            || request.max_steps == 0
            || request.temperature.is_some()
            || request.timeout.is_zero()
        {
            return Err(error("invalid_descriptor"));
        }
        let task = available(
            self.scheduler
                .token_budget(&self.context.task_lease, self.context.now_ms()),
        )
        .map_err(error)?;
        if task.finalize_fired || task.hard_stopped() {
            return Err(error("token_budget"));
        }
        let remaining = task.budget.saturating_sub(task.spent);
        let budget = Some(request.token_budget.unwrap_or(remaining).min(remaining));
        Ok((provider.into(), name.into(), budget))
    }

    /// What this runner must declare for this request, and what to send.
    fn negotiate(
        &self,
        describe: &RoleDescribe,
        request: &ChildRequest,
        budget: Option<u64>,
    ) -> Result<(ChildRetention, Option<u64>, Option<&'static str>), CarrierError> {
        // Retention is required in one of its two groups; the declared group
        // picks the send member (see `child_retention`).
        let member = child_retention::member(|group| describe.declares(group));
        // Every dream child has a mandatory step bound; usage cancellation cannot
        // replace the runner sealing pending calls at that exact model response.
        let mut required = vec![
            caps::QUEUE,
            caps::RUN_OPS,
            caps::RUN_STATUS,
            caps::STREAMING,
            caps::MAX_STEPS,
        ];
        if member == RetentionMember::Nothing {
            required.insert(4, caps::RETENTION);
        }
        if request.allowed_tools.is_empty() {
            required.push(caps::NO_TOOLS);
        }
        if !request.allowed_tools.is_empty() {
            required.push(caps::PLANS);
        }
        let missing = describe.missing(&required);
        if !missing.is_empty() {
            return Err(error(format!("unavailable: {}", missing.join(","))));
        }
        let retention = if member == RetentionMember::Policy {
            // A keep-nothing child is deleted on release, or at the latest
            // `max_unreleased_hold_ms` after its run ends when no release
            // arrives; a privacy-sensitive dream needs that within the hour.
            let limits = describe
                .session_retention
                .as_ref()
                .ok_or_else(|| error("unavailable: session_retention"))?;
            if self.policy.privacy_sensitive
                && limits.max_unreleased_hold_ms > PRIVATE_DELETE_WITHIN_MS
            {
                return Err(error("unavailable: retention_deletion_too_slow"));
            }
            ChildRetention::Policy
        } else {
            let limits = describe
                .retention
                .filter(|r| r.max_seconds > 0 && r.delete_within_ms > 0)
                .ok_or_else(|| error("unavailable: retention"))?;
            if self.policy.privacy_sensitive && limits.delete_within_ms > PRIVATE_DELETE_WITHIN_MS {
                return Err(error("unavailable: retention_deletion_too_slow"));
            }
            ChildRetention::Seconds(
                if self.policy.privacy_sensitive {
                    request
                        .timeout
                        .as_secs()
                        .saturating_add(u64::from(request.timeout.subsec_nanos() > 0))
                        .saturating_add(PRIVATE_RETENTION_SLACK_SECONDS)
                } else {
                    ORDINARY_RETENTION_SECONDS
                }
                .min(limits.max_seconds),
            )
        };
        let advertised = describe.declares(caps::INPUT_TOKEN_CAP);
        if budget.is_some() && !advertised && self.policy.require_hard_cap {
            return Err(error("unavailable: input_token_cap"));
        }
        // Without the capability the budget is enforced from cumulative run usage:
        // the run can overshoot by the step in flight before the cancel lands.
        let cap = budget.filter(|_| advertised);
        let cancel_at = if !describe.declares(caps::RUN_CANCEL) {
            None
        } else if describe
            .run_cancel
            .as_ref()
            .is_some_and(|c| c.at.iter().any(|at| at == cancel_at::STEP_BOUNDARY))
        {
            Some(cancel_at::STEP_BOUNDARY)
        } else {
            Some(cancel_at::NOW)
        };
        if cancel_at.is_none() || !describe.declares(caps::RETRACT) {
            return Err(error("unavailable: run_cancel_or_retract"));
        }
        Ok((retention, cap, cancel_at))
    }

    fn send_params(
        &self,
        session: &str,
        request: &ChildRequest,
        (provider, name): (&str, &str),
        retention: ChildRetention,
        cap: Option<u64>,
    ) -> Result<Value, CarrierError> {
        let mut params = Map::new();
        let mut model = json!({"provider": provider, "model": name});
        if let Some(variant) = request
            .model
            .as_ref()
            .and_then(|m| m.qualifier.as_deref())
            .filter(|v| !v.is_empty())
        {
            model["variant"] = json!(variant);
        }
        params.insert("model".into(), model);
        if !request.system.is_empty() {
            params.insert("system".into(), json!(request.system));
        }
        // A plan freezes the non-empty tool allowlist at admission. Even an empty
        // override would suppress those tools on a no_tools runner, and later
        // sends into a plan-admitted session must not carry a tools override.
        let mut send = SendRequest::new(request.prompt.clone(), session)
            .with_runner_params(params)
            .with_max_steps(u64::from(request.max_steps));
        // Never both members: a runner refuses a send carrying both.
        match retention {
            ChildRetention::Policy => send = send.with_retention_policy(child_policy()),
            ChildRetention::Seconds(seconds) => send = send.with_retention(seconds),
            ChildRetention::Nothing => {}
        }
        if request.allowed_tools.is_empty() {
            send = send.with_no_tools();
        }
        let (memory, files): (Vec<&str>, Vec<&str>) = request
            .allowed_tools
            .iter()
            .partition(|t| MC_TOOLS.contains(t));
        let mut items = Vec::new();
        if !memory.is_empty() {
            items.push(json!({"provider": self.policy.module_id, "item": "tools",
                "params": {"tools": memory}}));
        }
        if !files.is_empty() {
            items.push(json!({"provider": FILE_TOOL_PROVIDER, "item": "tools",
                "params": {"tools": files, "root": request.directory}}));
        }
        if !items.is_empty() {
            let mut plan = Map::new();
            plan.insert("items".into(), Value::Array(items));
            send = send.with_plan(plan);
        }
        if let Some(cap) = cap {
            send = send.with_budget(Budget::new().with_max_input_tokens(cap));
        }
        serde_json::to_value(send).map_err(|e| error(e.to_string()))
    }

    /// Charge only deltas of the role's cumulative run usage. Replayed wake
    /// events cannot duplicate a charge; subscription-event bodies supply no spend.
    fn record_usage(
        &mut self,
        measured: &cortexkit_role_llm_runner::usage::RunUsage,
    ) -> Result<(), CarrierError> {
        let Some(total) = crate::historian_producer::ProducerUsage::from_contract_usage(measured)
        else {
            return Ok(());
        };
        let attempt = self.attempt.as_mut().ok_or_else(|| error("not_opened"))?;
        let delta = Usage {
            input: total
                .input
                .checked_sub(attempt.total.input)
                .ok_or_else(|| error("run_usage_regressed"))?,
            output: total
                .output
                .checked_sub(attempt.total.output)
                .ok_or_else(|| error("run_usage_regressed"))?,
            cache_read: total
                .cache_read
                .checked_sub(attempt.total.cache_read)
                .ok_or_else(|| error("run_usage_regressed"))?,
            cache_write: total
                .cache_write
                .checked_sub(attempt.total.cache_write)
                .ok_or_else(|| error("run_usage_regressed"))?,
        };
        if delta == Usage::default() {
            return Ok(());
        }
        attempt.total = Usage {
            input: total.input,
            output: total.output,
            cache_read: total.cache_read,
            cache_write: total.cache_write,
        };
        let session = attempt.session.clone();
        let id = format!(
            "usage-{}-{}-{}-{}-{}",
            measured.steps, total.input, total.output, total.cache_read, total.cache_write
        );
        let task = self
            .context
            .control
            .charge_usage(&format!("{session}:{id}"), &delta, false, true)
            .map_err(|e| error(format!("{e:?}")))?;
        let local = self
            .routes
            .update(&session, |entry| {
                entry.budget.as_mut().map(|budget| {
                    budget.charge(
                        delta.input,
                        delta.cache_read,
                        delta.cache_write,
                        false,
                        true,
                    )
                })
            })
            .flatten()
            .transpose()
            .map_err(error)?;
        if task == BudgetAction::Stop || local == Some(BudgetAction::Stop) {
            attempt
                .stop_reason
                .get_or_insert_with(|| "token_budget".into());
        }
        self.observer
            .observe(
                &session,
                ChildEvent::Usage {
                    message_id: id,
                    usage: delta,
                },
            )
            .map_err(|e| error(format!("observer_failed: {e:?}")))?;
        Ok(())
    }

    async fn drain(&mut self, session: &str) -> Result<bool, CarrierError> {
        // Stop at the first control wake. In particular, do not interpret a
        // runner's assistant-message, usage or terminal event schema.
        while let Some(event) = self
            .port
            .next_unit(session)
            .await
            .map_err(|e| port_error("session.subscribe", e))?
        {
            if crate::runner_follow::control_wake(&event) {
                return Ok(true);
            }
            if self.must_stop() {
                break;
            }
        }
        Ok(false)
    }

    /// Latch a stop for cancellation, deadline, lease loss or an exhausted budget.
    fn must_stop(&mut self) -> bool {
        let control = self.context.check_control().err();
        let Some(attempt) = self.attempt.as_mut() else {
            return false;
        };
        if let Some(e) = control {
            attempt.stop_reason.get_or_insert_with(|| format!("{e:?}"));
        }
        if attempt.stop_reason.is_some() {
            let session = attempt.session.clone();
            self.routes.update(&session, |e| e.stop = true);
            return true;
        }
        false
    }

    async fn result(&mut self, session: &str) -> Result<Option<RunResult>, CarrierError> {
        let Some(run) = self.attempt.as_ref().and_then(|a| a.run_id.clone()) else {
            return Ok(None);
        };
        let answer = self
            .port
            .call(session, ops::RUN_STATUS, json!({"run_id": run}))
            .await
            .map_err(|e| port_error(ops::RUN_STATUS, e))?;
        let status: cortexkit_role_llm_runner::run::RunStatus =
            serde_json::from_value(reply_answer(ops::RUN_STATUS, answer)?)
                .map_err(|e| error(e.to_string()))?;
        if let Some(usage) = status
            .usage
            .as_ref()
            .filter(|_| self.attempt.as_ref().is_some_and(|a| a.reports_usage))
        {
            self.record_usage(usage)?;
        }
        if !status.run_state().is_terminal() {
            return Ok(None);
        }
        let answer = self
            .port
            .call(session, ops::RUN_RESULT, json!({"run_id": run}))
            .await
            .map_err(|e| port_error(ops::RUN_RESULT, e))?;
        let result: RunResult = serde_json::from_value(reply_answer(ops::RUN_RESULT, answer)?)
            .map_err(|e| error(e.to_string()))?;
        if result.run_id != run
            || result.state != status.state
            || !result.final_message_consistent()
        {
            return Err(error("run_result_malformed"));
        }
        if let Some(usage) = result
            .usage
            .as_ref()
            .filter(|_| self.attempt.as_ref().is_some_and(|a| a.reports_usage))
        {
            self.record_usage(usage)?;
        }
        Ok(Some(result))
    }

    async fn cancel(&mut self, session: &str) -> Result<(), CarrierError> {
        let Some(attempt) = self.attempt.as_mut() else {
            return Ok(());
        };
        if attempt.cancel_sent {
            return Ok(());
        }
        let Some(run) = attempt.run_id.clone() else {
            return Ok(());
        };
        let mut params = json!({"run_id": run});
        if let Some(at) = attempt.cancel_at.filter(|at| *at != cancel_at::NOW) {
            params["at"] = json!(at);
        }
        let answer = self
            .port
            .call(session, ops::RUN_CANCEL, params)
            .await
            .map_err(|e| port_error(ops::RUN_CANCEL, e))?;
        // An ack accepts the cancel; only run.result says which terminal won.
        match serde_json::from_value::<RunCancelReply>(reply_answer(ops::RUN_CANCEL, answer)?) {
            Ok(RunCancelReply::Ack | RunCancelReply::NotActive) => {
                if let Some(attempt) = self.attempt.as_mut() {
                    attempt.cancel_sent = true;
                }
                Ok(())
            }
            _ => Err(error("cancel_unconfirmed")),
        }
    }

    /// Send the prompt once. A lost reply is retried with the identical request,
    /// whose `send_id` makes the runner answer the existing state.
    async fn start(&mut self, session: &str) -> Result<(), CarrierError> {
        let params = self
            .attempt
            .as_ref()
            .map(|a| a.send.clone())
            .ok_or_else(|| error("not_opened"))?;
        self.routes.update(session, |e| e.started = true);
        if let Some(a) = self.attempt.as_mut() {
            a.sent = true;
        }
        let mut reply = None;
        for _ in 0..SEND_ATTEMPTS {
            match self
                .port
                .call(session, ops::SESSION_SEND, params.clone())
                .await
            {
                Ok(answer) => {
                    reply = Some(answer);
                    break;
                }
                Err(e) if e.outcome_unknown => continue,
                Err(e) => {
                    self.routes.update(session, |e| e.stop = true);
                    if let Some(a) = self.attempt.as_mut() {
                        a.refused = true;
                    }
                    return Err(port_error(ops::SESSION_SEND, e));
                }
            }
        }
        loop {
            let answer = reply.ok_or_else(|| error("send_outcome_unknown"))?;
            let sent: SendReply = serde_json::from_value(reply_answer(ops::SESSION_SEND, answer)?)
                .map_err(|e| error(e.to_string()))?;
            let attempt = self.attempt.as_mut().ok_or_else(|| error("not_opened"))?;
            match sent.send_state() {
                SendState::Active | SendState::Finished | SendState::Paused => {
                    attempt.run_id = Some(sent.run_id.ok_or_else(|| error("missing_run_id"))?);
                    return Ok(());
                }
                SendState::Pending => {
                    attempt.submission = sent.submission_id;
                    if let Some(e) = self.context.check_control().err() {
                        return Err(error(format!("{e:?}")));
                    }
                    tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
                    reply = self
                        .port
                        .call(session, ops::SESSION_SEND, params.clone())
                        .await
                        .ok();
                }
                other => return Err(error(format!("send_state: {other:?}"))),
            }
        }
    }

    fn finish(&mut self, session: &str, result: RunResult) -> Result<Completion, CarrierError> {
        self.routes.update(session, |e| e.stop = true);
        let calls = self
            .routes
            .update(session, |e| e.calls.len())
            .unwrap_or_default();
        let attempt = self.attempt.as_mut().ok_or_else(|| error("not_opened"))?;
        if !attempt.final_observed {
            if let Some(message) = &result.final_message {
                self.observer
                    .observe(
                        session,
                        ChildEvent::Message {
                            message_id: message.mid.clone(),
                            role: "assistant".into(),
                            text: message.text.clone(),
                        },
                    )
                    .map_err(|e| error(format!("observer_failed: {e:?}")))?;
                attempt.final_observed = true;
            }
        }
        attempt.terminal = Some(result.clone());
        let state = result.run_state();
        match state {
            RunState::Completed => Ok(Completion {
                text: result.final_message.map(|m| m.text).unwrap_or_default(),
                length_capped: false,
                usage: attempt.total.clone(),
            }),
            // An interrupted run may hold an indeterminate tool call. The runner
            // never re-dispatches it and this carrier never resends the prompt.
            RunState::Interrupted => Err(error("interrupted")),
            RunState::Error => Err(CarrierError {
                message: result.error.map_or_else(
                    || "run_error".into(),
                    |e| format!("run_error: {}", e.message),
                ),
                // A fresh attempt is safe only when no memory tool ran in this one.
                retryable: calls == 0,
            }),
            // The runner's hard cap (or an unreported step under it) is the
            // task's token-budget failure: final for this task, never retried.
            _ if state.is_budget_exhausted() => Err(error(match result.detail {
                Some(d) => format!(
                    "token_budget: budget_exhausted limit {} spent {} cause {}",
                    d.limit, d.spent, d.cause
                ),
                None => "token_budget: budget_exhausted".into(),
            })),
            RunState::MaxSteps => Err(error("max_steps")),
            // A cancel this carrier sent reports why it stopped the run.
            RunState::Cancelled => Err(error(
                attempt
                    .stop_reason
                    .clone()
                    .unwrap_or_else(|| "cancelled".into()),
            )),
            _ => Err(error(format!("run_ended: {}", result.state))),
        }
    }

    /// Wait for a terminal status and account any final run.result usage.
    async fn quiesce(&mut self, session: &str) -> Result<(), CarrierError> {
        let cleanup = async {
            let attempt = self.attempt.as_ref().ok_or_else(|| error("not_opened"))?;
            if attempt.terminal.is_some() {
                return Ok(());
            }
            if attempt.run_id.is_none() && (!attempt.sent || attempt.refused) {
                return Ok(());
            }
            if attempt.run_id.is_none() {
                let submission = attempt.submission.clone();
                let can_retract = attempt.can_retract;
                let Some(submission) = submission.filter(|_| can_retract) else {
                    // The send was never confirmed: its run, if any, is unknown.
                    return Err(error("cleanup_unknown"));
                };
                let answer = self
                    .port
                    .call(
                        session,
                        ops::SESSION_RETRACT,
                        json!({"submission_id": submission}),
                    )
                    .await
                    .map_err(|e| port_error(ops::SESSION_RETRACT, e))?;
                match serde_json::from_value::<RetractReply>(reply_answer(
                    ops::SESSION_RETRACT,
                    answer,
                )?) {
                    Ok(RetractReply::Retracted) => return Ok(()),
                    _ => return Err(error("cleanup_unknown")),
                }
            }
            self.cancel(session).await?;
            loop {
                self.drain(session).await?;
                if let Some(result) = self.result(session).await? {
                    if let Some(a) = self.attempt.as_mut() {
                        a.terminal = Some(result);
                    }
                    return Ok(());
                }
                tokio::time::sleep(crate::runner_follow::POLL_INTERVAL).await;
            }
        };
        tokio::time::timeout(Duration::from_millis(CLEANUP_MS), cleanup)
            .await
            .map_err(|_| error("cleanup_unknown"))?
    }

    /// Release a quiesced child whose result has been consumed: one
    /// `session.release {}` call, its outcome logged once and never retried.
    /// Only a child sent `retention_policy` is released, and only when its
    /// send may have created the session.
    async fn release_child(&mut self, session: &str) {
        let Some(attempt) = self.attempt.as_ref() else {
            return;
        };
        if !attempt.release || !attempt.sent || attempt.refused {
            return;
        }
        let outcome = match self
            .port
            .call(session, child_retention::SESSION_RELEASE, json!({}))
            .await
        {
            Ok(reply) => match reply_answer(child_retention::SESSION_RELEASE, reply) {
                Ok(answer) => ReleaseOutcome::from_answer(&answer),
                Err(e) => ReleaseOutcome::Unanswered(e.message),
            },
            Err(e) if !e.outcome_unknown => ReleaseOutcome::Refused {
                code: e.code,
                detail: e.detail,
            },
            Err(e) => ReleaseOutcome::Unanswered(e.message),
        };
        child_retention::log_release("dream", &self.context.scope.session.0, session, &outcome);
    }
}

struct OpenGuard {
    routes: Arc<BrocaToolRoute>,
    session: String,
    armed: bool,
}

impl Drop for OpenGuard {
    fn drop(&mut self) {
        if self.armed {
            // Nothing was sent, so no run exists; the session prefix keeps any
            // later call on this session away from the foreground facade.
            self.routes.remove(&self.session);
        }
    }
}

impl<P: BrocaPort> Drop for BrocaCarrier<P> {
    fn drop(&mut self) {
        if let Some(attempt) = &self.attempt {
            self.routes.remove(&attempt.session);
        }
    }
}

impl<P: BrocaPort> DreamCarrier for BrocaCarrier<P> {
    async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError> {
        if self.attempt.is_some() {
            return Err(error("prior_cleanup_required"));
        }
        let (provider, name, budget) = self.admit(request)?;
        let session = format!("{SESSION_PREFIX}{}", secret()?);
        let allowed = request
            .allowed_tools
            .iter()
            .copied()
            .filter(|t| MC_TOOLS.contains(t))
            .collect();
        self.routes.insert(
            &session,
            Entry {
                context: self.context.clone(),
                allowed,
                router: self.router.clone(),
                observer: self.observer.clone(),
                budget: budget.map(TokenBudget::new).transpose().map_err(error)?,
                calls: HashMap::new(),
                call_bytes: 0,
                started: false,
                stop: false,
            },
        )?;
        let mut guard = OpenGuard {
            routes: self.routes.clone(),
            session: session.clone(),
            armed: true,
        };
        let answer = self
            .port
            .call(&session, ops::ROLE_DESCRIBE, json!({}))
            .await
            .map_err(|e| port_error(ops::ROLE_DESCRIBE, e))?;
        let describe = check_describe(&reply_answer(ops::ROLE_DESCRIBE, answer)?)
            .map_err(|problems| error(format!("unavailable: describe {problems:?}")))?;
        // The task may have been cancelled or lost its lease while discovery ran.
        self.context
            .check_control()
            .map_err(|e| error(format!("{e:?}")))?;
        let (retention, cap, cancel_at) = self.negotiate(&describe, request, budget)?;
        let send = self.send_params(&session, request, (&provider, &name), retention, cap)?;
        guard.armed = false;
        self.attempt = Some(Attempt {
            session: session.clone(),
            send,
            cancel_at,
            can_retract: describe.declares(caps::RETRACT),
            sent: false,
            refused: false,
            run_id: None,
            submission: None,
            terminal: None,
            cancel_sent: false,
            stop_reason: None,
            total: Usage::default(),
            final_observed: false,
            reports_usage: describe.declares(caps::RUN_USAGE),
            release: retention == ChildRetention::Policy,
        });
        Ok(session)
    }

    async fn complete(
        &mut self,
        child: &str,
        _request: &ChildRequest,
    ) -> Result<Completion, CarrierError> {
        let attempt = self.attempt(child)?;
        if let Some(result) = attempt.terminal.clone() {
            return self.finish(child, result);
        }
        if attempt.run_id.is_none() {
            self.start(child).await?;
        }
        let mut last_probe: Option<std::time::Instant> = None;
        loop {
            let wake = self.drain(child).await?;
            if wake
                || last_probe
                    .is_none_or(|last| last.elapsed() >= crate::runner_follow::POLL_INTERVAL)
            {
                if let Some(result) = self.result(child).await? {
                    return self.finish(child, result);
                }
                last_probe = Some(std::time::Instant::now());
            }
            if self.must_stop() {
                self.cancel(child).await?;
            }
            tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
        }
    }

    async fn close(&mut self, child: &str, prompt_settled: bool) -> Result<(), CarrierError> {
        self.attempt(child)?;
        // No memory effect after close begins, whatever the run does next.
        self.routes.update(child, |e| e.stop = true);
        self.quiesce(child).await?;
        self.release_child(child).await;
        self.routes.remove(child);
        self.port.release(child).await;
        self.attempt = None;
        self.observer
            .observe(
                child,
                ChildEvent::Closed {
                    settled: prompt_settled,
                },
            )
            .map_err(|e| error(format!("observer_failed: {e:?}")))
    }
}

#[cfg(test)]
mod tests;
