//! A fake Broca drives the carrier through the llm-runner/v1 shapes and calls
//! Magic Context's tool route through `McHandler::dispatch_value`, exactly as a
//! runner dispatches a plan tool item. The fake honours the send's `stop_when`,
//! `budget.max_input_tokens` and frozen tool allowlist the way the contract
//! describes, and has adversarial knobs (ignore its own allowlist, lose a tool
//! reply, dispatch the same call again) so each Magic Context guard is reached
//! by a real call that would have an observable effect if admitted.

use super::*;
use crate::dream_dispatch::context::*;
use crate::dream_runner::{
    run_dream_task, ChildRequest, DreamRequest, DreamRole, Failure, ModelEntry,
};
use crate::historian_runner::ResolvedRunner;
use crate::{McModuleConfig, SessionBinding};
use cortexkit_role_llm_runner::describe::Major;
use cortexkit_role_llm_runner::run::{BudgetExhaustedDetail, FinalMessage, RunStatus};
use cortexkit_role_llm_runner::usage::{RunUsage, StepUsage};
use mc_store::dream_domain::DreamDomainLease;
use mc_store::dream_scheduler::schedules::{TaskConfig, TaskName};
use mc_store::parity_schema_manifest::*;
use std::collections::VecDeque;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

mod held_calls;

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// Task control with only a lease switch: the task-wide ledger never refuses,
/// so each test reaches the carrier's own guard rather than this fixture's.
struct Control {
    lease: AtomicBool,
    charges: Mutex<Vec<(String, Usage)>>,
}
impl TaskControl for Control {
    fn check_control(&self) -> Result<(), ControlError> {
        if self.lease.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(ControlError::LeaseLost)
        }
    }
    fn charge_usage(
        &self,
        id: &str,
        usage: &Usage,
        _: bool,
        _: bool,
    ) -> Result<BudgetAction, ControlError> {
        self.charges
            .lock()
            .unwrap()
            .push((id.into(), usage.clone()));
        Ok(BudgetAction::Continue)
    }
    fn refuse_tool(&self) -> Result<Option<(&'static str, bool)>, ControlError> {
        Ok(None)
    }
}

/// A deliberately permissive router: every call it receives is an effect.
#[derive(Default)]
struct Effects {
    calls: Mutex<Vec<(String, String, Value)>>,
    observations: Mutex<Vec<(String, ChildEvent)>>,
}
impl Effects {
    fn executed(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|c| c.1.clone())
            .collect()
    }
}
impl TaskToolRouter for Effects {
    fn execute(&self, child: &str, tool: &str, arguments: &Value) -> Result<ToolResult, ToolError> {
        self.calls
            .lock()
            .unwrap()
            .push((child.into(), tool.into(), arguments.clone()));
        Ok(ToolResult {
            output: json!({"effect": "applied"}),
            receipt: Some(ToolReceipt {
                tool: tool.into(),
                affected_ids: vec!["memory-1".into()],
                details: json!({"committed": true}),
            }),
        })
    }
}
impl ChildObserver for Effects {
    fn observe(&self, child: &str, event: ChildEvent) -> Result<(), ToolError> {
        self.observations
            .lock()
            .unwrap()
            .push((child.into(), event));
        Ok(())
    }
}

#[derive(Clone, Default)]
struct Step {
    input: u64,
    calls: Vec<(&'static str, Value)>,
    text: Option<&'static str>,
    /// The step never finishes on its own (a long model call).
    hang: bool,
    /// The provider reported no usage for this step.
    unreported: bool,
    cache_read: u64,
    cache_write: u64,
}

struct Run {
    id: String,
    allow: Vec<String>,
    max_steps: Option<u64>,
    cap: Option<u64>,
    spent: u64,
    usage: RunUsage,
    done: usize,
    units: VecDeque<Value>,
    terminal: Option<RunResult>,
    cancel: bool,
    /// The `aft` plan item's root and tools: the calls AFT serves for this run
    /// instead of Magic Context. See [`FakeBroca::aft`].
    files: Option<(std::path::PathBuf, Vec<String>)>,
}

#[derive(Default)]
struct State {
    describe: Value,
    /// Capability discovery may choose a file provider other than AFT.
    file_provider: Option<String>,
    /// Answer every op bare instead of inside `{"result": ...}`, as a runner
    /// off the pinned llm-runner reply shape would.
    bare_replies: bool,
    open_controls: bool,
    quiet_stream: bool,
    quiet_active_probes: usize,
    gate: Option<Arc<tokio::sync::Notify>>,
    log: Vec<(String, String, Value)>,
    lose_send_replies: usize,
    send_reply: Option<Value>,
    steps: Vec<Step>,
    ignore_allowlist: bool,
    ignore_cancel: bool,
    /// Index of the dispatched call whose reply is lost: its outcome becomes
    /// indeterminate and the run seals `interrupted`.
    lose_tool_reply: Option<usize>,
    /// Misbehave by dispatching that indeterminate call again with its key.
    redispatch: bool,
    on_step: Option<Box<dyn Fn(usize) + Send>>,
    sends: HashMap<String, (Value, Value)>,
    run: Option<Run>,
    dispatched: usize,
    wal_seq: u64,
    results: Vec<(String, Value)>,
    /// Calls given the runner's never-executed result instead of a dispatch.
    never_executed: Vec<(String, String)>,
    released: Vec<String>,
    /// Scripted answers to `session.release`, in order; once they run out the
    /// runner answers `deleted`.
    release_replies: VecDeque<Result<Value, PortError>>,
    /// When set, a step without tool calls answers with this text computed from
    /// every tool result so far, as a model would answer from what it read.
    compose: Option<ComposeFn>,
}

type ComposeFn = Box<dyn Fn(&[(String, Value)]) -> String + Send>;

#[derive(Clone)]
struct FakeBroca {
    state: Arc<Mutex<State>>,
    handler: Arc<McHandler>,
    directory: std::path::PathBuf,
}

const TOOL_CHANNEL: u16 = 41;

/// Broca 0.3.212's wire goldens, vendored with their checksums in `golden/README.md`.
const GOLDEN_DESCRIBE: &[u8] = include_bytes!("golden/role_describe.json");

fn child_runner_describe() -> Value {
    let mut describe: Value = serde_json::from_slice(GOLDEN_DESCRIBE).unwrap();
    // The frozen input-cap fixture predates runner-owned tags. These child-run
    // tests do not pair a compaction provider, so omit that unrelated capability.
    describe["capabilities"]
        .as_array_mut()
        .unwrap()
        .retain(|capability| capability != "compaction");
    for major in describe["majors"].as_array_mut().unwrap() {
        major["ops"]
            .as_array_mut()
            .unwrap()
            .retain(|op| op != "compaction.ready");
    }
    describe["capabilities"]
        .as_array_mut()
        .unwrap()
        .extend(["max_steps", "no_tools", "run_usage"].map(|group| json!(group)));
    describe
}
const GOLDEN_DESCRIBE_SHA256: &str =
    "b02c1aeba85bfc1ad3a6dde615ba049c047e1f5f2ced66f90043c4fe34a5b0a2";
const GOLDEN_EXHAUSTED: &[u8] = include_bytes!("golden/run_status.budget_exhausted.json");
const GOLDEN_EXHAUSTED_SHA256: &str =
    "45452b91e62fa53be019c22c3bd5f1db3af487d73bf8645c5516b2f53648955f";

/// One step's tool calls to dispatch and its final text.
type Batch = (Vec<(&'static str, Value)>, Option<&'static str>);

fn refused(code: &str, detail: Value) -> PortError {
    PortError {
        code: code.into(),
        message: code.into(),
        detail,
        outcome_unknown: false,
    }
}

impl FakeBroca {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    fn ops(&self, op: &str) -> Vec<Value> {
        self.state()
            .log
            .iter()
            .filter(|(_, o, _)| o == op)
            .map(|(_, _, p)| p.clone())
            .collect()
    }

    fn send(&self, session: &str, params: Value) -> Result<Value, PortError> {
        let mut s = self.state();
        let request: SendRequest = serde_json::from_value(params.clone())
            .map_err(|e| refused("invalid_params", json!({"field": e.to_string()})))?;
        if let Some((previous, reply)) = s.sends.get(&request.send_id) {
            return if previous == &params {
                Ok(reply.clone())
            } else {
                Err(refused("send_id_reuse", json!({"field": "prompt"})))
            };
        }
        let describe: RoleDescribe = serde_json::from_value(s.describe.clone()).unwrap();
        let max_steps = request
            .max_steps()
            .map_err(|field| refused("invalid_params", json!({"field":field})))?;
        let max_output_tokens = request
            .max_output_tokens()
            .map_err(|field| refused("invalid_params", json!({"field":field})))?;
        let no_tools = request
            .no_tools()
            .map_err(|field| refused("invalid_params", json!({"field":field})))?;
        for (group, offered) in [
            (caps::MAX_STEPS, max_steps.is_some()),
            (caps::MAX_OUTPUT_TOKENS, max_output_tokens.is_some()),
            (caps::NO_TOOLS, no_tools == Some(true)),
        ] {
            if offered && !describe.declares(group) {
                return Err(refused("invalid_params", json!({"field": group})));
            }
        }
        let advertised = describe.declares(caps::INPUT_TOKEN_CAP);
        let budget = request
            .budget()
            .map_err(|field| refused("invalid_params", json!({"field": field})))?;
        if let Some(budget) = &budget {
            budget
                .check(advertised, None)
                .map_err(|field| refused("invalid_params", json!({"field": field})))?;
        }
        let limits = describe
            .declares(caps::RETENTION)
            .then_some(describe.retention)
            .flatten();
        request
            .check_retention(limits.as_ref(), None)
            .map_err(|_| refused("invalid_params", json!({"field": "retention"})))?;
        // llm-runner §9.14, as a runner enforces it: `retention_policy` only to a
        // runner declaring `session_retention`, never beside `retention`.
        let session_limits = describe
            .declares(caps::SESSION_RETENTION)
            .then_some(describe.session_retention)
            .flatten();
        cortexkit_role_llm_runner::session_retention::check_policy(
            request.retention_policy.as_ref(),
            request.retention.is_some(),
            session_limits.as_ref(),
            true,
            None,
            None,
        )
        .map_err(|refusal| refused(&refusal.code, refusal.detail))?;
        request
            .check_plan(&describe.capabilities)
            .map_err(|field| refused("invalid_params", json!({"field": field})))?;
        // The allowlist frozen at admission: inline tools plus plan item tools.
        let mut allow: Vec<String> = request
            .runner_params
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|t| t.as_str().map(str::to_string))
            .collect();
        let items = request
            .plan
            .as_ref()
            .and_then(|p| p.get("items"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut files = None;
        for item in items {
            let tools: Vec<String> = item["params"]["tools"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|tool| tool.as_str().unwrap().to_string())
                .collect();
            if item["provider"] == s.file_provider.as_deref().unwrap_or(FILE_TOOL_PROVIDER) {
                let root = item["params"]["root"].as_str().unwrap_or_default();
                files = Some((std::path::PathBuf::from(root), tools.clone()));
            }
            allow.extend(tools);
        }
        if no_tools == Some(true) {
            allow.clear();
        }
        s.run = Some(Run {
            id: "run-1".into(),
            allow,
            max_steps,
            cap: budget.and_then(|b| b.max_input_tokens),
            spent: 0,
            usage: RunUsage::new(),
            done: 0,
            units: VecDeque::new(),
            terminal: None,
            cancel: false,
            files,
        });
        let reply = serde_json::to_value(SendReply::new("active").with_run_id("run-1")).unwrap();
        s.sends
            .insert(request.send_id.clone(), (params, reply.clone()));
        // The daemon binds the runner's tool route to the child session.
        self.handler.bind_route(
            TOOL_CHANNEL,
            SessionBinding {
                principal: None,
                scope: None,
                project_root: self.directory.clone(),
                harness: "broca".into(),
                session: session.into(),
                model_key: None,
                config: McModuleConfig::default(),
                history_budget_tokens: 1000.0,
            },
        );
        if s.lose_send_replies > 0 {
            s.lose_send_replies -= 1;
            return Err(PortError {
                outcome_unknown: true,
                ..refused("transport_lost", Value::Null)
            });
        }
        Ok(reply)
    }

    fn terminal(run: &mut Run, state: &str, detail: Option<BudgetExhaustedDetail>) {
        let mut result = RunResult::new(run.id.clone(), state).with_usage(run.usage.clone());
        if let Some(detail) = detail {
            result = result.with_detail(detail);
        }
        run.terminal = Some(result);
    }

    /// One model step, its usage report and its tool batch, under the send's
    /// limits. Answers the tool calls to dispatch.
    fn begin_step(&self) -> Option<Batch> {
        let mut s = self.state();
        let steps = s.steps.clone();
        let ignore_allowlist = s.ignore_allowlist;
        let index = s.run.as_ref()?.done;
        if let Some(hook) = &s.on_step {
            hook(index);
        }
        let run = s.run.as_mut()?;
        if run.terminal.is_some() {
            return None;
        }
        if run.cancel {
            Self::terminal(run, "cancelled", None);
            return None;
        }
        if run.cap.is_some_and(|cap| run.spent >= cap) {
            let detail = BudgetExhaustedDetail::new(run.cap.unwrap(), run.spent, "limit_reached");
            Self::terminal(run, "budget_exhausted", Some(detail));
            return None;
        }
        if run.max_steps.is_some_and(|max| run.done as u64 >= max) {
            Self::terminal(run, "max_steps", None);
            return None;
        }
        let Some(step) = steps.get(run.done).cloned() else {
            Self::terminal(run, "error", None);
            return None;
        };
        if step.hang {
            return None;
        }
        run.done += 1;
        let measured_usage = if step.unreported {
            StepUsage::unreported()
        } else {
            StepUsage::unreported()
                .with_input_tokens(step.input)
                .with_cached_input_tokens(step.cache_read)
                .with_cache_write_tokens(step.cache_write)
                .with_output_tokens(500)
        };
        run.usage
            .record_step("provider", "model", None, measured_usage);
        // The cap counts input, cache-read and cache-write tokens, never output.
        let measured = step.input + step.cache_read + step.cache_write;
        run.spent += measured;
        let mid = format!("m{}", run.done);
        run.units.push_back(json!({"kind": "control", "unit": {"type": "assistant_message",
            "run_id": run.id, "mid": mid, "message": {"content": [{"type": "text", "text": step.text.unwrap_or("")}]}}}));
        let mut finished = json!({"type": "step_finished", "run_id": run.id, "mid": mid});
        if !step.unreported {
            finished["usage"] = json!({"input_tokens": step.input, "output_tokens": 500,
                "cached_input_tokens": step.cache_read, "cache_write_tokens": step.cache_write});
        }
        run.units
            .push_back(json!({"kind": "control", "unit": finished}));
        // After the step and before any of its tools: an unmeasured step fails
        // closed without being counted, and a cap of N stops at exactly N.
        let exhausted = match run.cap {
            Some(cap) if step.unreported => {
                run.spent -= measured;
                Some(BudgetExhaustedDetail::new(
                    cap,
                    run.spent,
                    "usage_unreported",
                ))
            }
            Some(cap) if run.spent >= cap => {
                Some(BudgetExhaustedDetail::new(cap, run.spent, "limit_reached"))
            }
            _ => None,
        };
        if let Some(detail) = exhausted {
            // Every undispatched call gets the never-executed result in the
            // same commit as the terminal state.
            let mut never = Vec::new();
            for (index, (name, _)) in step.calls.iter().enumerate() {
                run.units
                    .push_back(json!({"kind": "control", "unit": {"type": "tool_result",
                    "run_id": run.id, "tool_call_id": format!("{mid}-{index}"), "name": name,
                    "status": "not_executed", "reason": "budget_exhausted"}}));
                never.push((name.to_string(), "budget_exhausted".to_string()));
            }
            Self::terminal(run, "budget_exhausted", Some(detail));
            s.never_executed.extend(never);
            return None;
        }
        let calls = step
            .calls
            .iter()
            .filter(|(name, _)| ignore_allowlist || run.allow.iter().any(|a| a == name))
            .cloned()
            .collect();
        Some((calls, step.text))
    }

    async fn dispatch(&self, name: &str, arguments: &Value, key: &str) -> Value {
        let files = self
            .state()
            .run
            .as_ref()
            .and_then(|run| run.files.clone())
            .filter(|(_, tools)| tools.iter().any(|tool| tool == name));
        if let Some((root, _)) = files {
            return Self::aft(&root, name, arguments);
        }
        let request = json!({"name": name, "arguments": arguments, "call_key": key});
        match Box::pin(self.handler.dispatch_value(TOOL_CHANNEL, request)).await {
            HandlerOutcome::Response(bytes) => serde_json::from_slice(&bytes).unwrap(),
            HandlerOutcome::Error { code, message } => json!({"error": code, "message": message}),
            other => panic!("unexpected tool outcome {other:?}"),
        }
    }

    async fn advance(&self) {
        let Some((calls, text)) = self.begin_step() else {
            return;
        };
        for (name, arguments) in &calls {
            let key = {
                let mut s = self.state();
                s.wal_seq += 1;
                format!("lineage-1:{}", s.wal_seq)
            };
            let outcome = self.dispatch(name, arguments, &key).await;
            let (lost, redispatch) = {
                let mut s = self.state();
                let lost = s.lose_tool_reply == Some(s.dispatched);
                s.dispatched += 1;
                s.results.push((name.to_string(), outcome));
                (lost, s.redispatch)
            };
            if lost {
                if redispatch {
                    let again = self.dispatch(name, arguments, &key).await;
                    self.state().results.push((name.to_string(), again));
                }
                // Durable intent, no result: indeterminate, and the run seals.
                let mut s = self.state();
                let run = s.run.as_mut().unwrap();
                Self::terminal(run, "interrupted", None);
                return;
            }
        }
        let mut s = self.state();
        let composed = calls
            .is_empty()
            .then(|| s.compose.as_ref().map(|compose| compose(&s.results)))
            .flatten();
        let run = s.run.as_mut().unwrap();
        if calls.is_empty() {
            if let Some(text) = composed.or(text.map(str::to_string)) {
                run.terminal = Some(
                    RunResult::new(run.id.clone(), "completed")
                        .with_usage(run.usage.clone())
                        .with_final_message(FinalMessage {
                            ordinal: run.done as u64,
                            mid: format!("m{}", run.done),
                            text,
                        }),
                );
            }
        }
    }

    /// The read tools as AFT serves them to a Broca child: real reads of the
    /// files under the plan item's `root`, refusing any path that resolves
    /// outside it. Only `read` and `grep` are needed by the tests.
    fn aft(root: &std::path::Path, name: &str, arguments: &Value) -> Value {
        let Ok(root) = root.canonicalize() else {
            return json!({"ok": false, "error": "root_unavailable"});
        };
        let inside = |relative: &str| {
            root.join(relative)
                .canonicalize()
                .ok()
                .filter(|path| path.starts_with(&root) && path.is_file())
        };
        match name {
            "read" => {
                let relative = arguments["filePath"].as_str().unwrap_or_default();
                match inside(relative).and_then(|path| std::fs::read_to_string(path).ok()) {
                    Some(content) => json!({"ok": true, "path": relative, "content": content}),
                    None => json!({"ok": false, "error": "path_not_readable", "path": relative}),
                }
            }
            "grep" => {
                let pattern = arguments["pattern"].as_str().unwrap_or_default();
                let mut matches = Vec::new();
                let mut pending = vec![root.clone()];
                while let Some(dir) = pending.pop() {
                    let Ok(entries) = std::fs::read_dir(&dir) else {
                        continue;
                    };
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.file_name().is_some_and(|n| n == ".git") {
                            continue;
                        }
                        if path.is_dir() {
                            pending.push(path);
                        } else if std::fs::read_to_string(&path)
                            .is_ok_and(|content| content.contains(pattern))
                        {
                            let relative = path.strip_prefix(&root).unwrap();
                            matches.push(relative.to_string_lossy().replace('\\', "/"));
                        }
                    }
                }
                matches.sort();
                json!({"ok": true, "files": matches})
            }
            other => json!({"ok": false, "error": "unknown_tool", "tool": other}),
        }
    }
}

impl BrocaPort for FakeBroca {
    /// The answer in the pinned llm-runner reply shape, `{"result": <answer>}`,
    /// unless the test asked for bare replies.
    async fn call(&mut self, session: &str, op: &str, params: Value) -> Result<Value, PortError> {
        let answer = self.answer(session, op, params).await?;
        Ok(if self.state().bare_replies {
            answer
        } else {
            json!({ "result": answer })
        })
    }

    async fn next_unit(&mut self, session: &str) -> Result<Option<Value>, PortError> {
        self.next_unit_of(session).await
    }

    async fn release(&mut self, session: &str) {
        self.release_of(session).await;
    }
}

impl FakeBroca {
    /// The answer to one op, before the reply envelope.
    async fn answer(&mut self, session: &str, op: &str, params: Value) -> Result<Value, PortError> {
        let gate = {
            let mut s = self.state();
            s.log.push((session.into(), op.into(), params.clone()));
            s.gate.clone()
        };
        match op {
            "role.describe" => {
                if let Some(gate) = gate {
                    gate.notified().await;
                }
                Ok(self.state().describe.clone())
            }
            "session.send" => {
                let reply = self.send(session, params)?;
                Ok(self.state().send_reply.clone().unwrap_or(reply))
            }
            "run.result" => {
                let s = self.state();
                let run = s
                    .run
                    .as_ref()
                    .ok_or_else(|| refused("unknown_run", Value::Null))?;
                Ok(serde_json::to_value(
                    run.terminal
                        .clone()
                        .unwrap_or_else(|| RunResult::new(run.id.clone(), "active")),
                )
                .unwrap())
            }
            "run.cancel" => {
                let mut s = self.state();
                let ignore = s.ignore_cancel;
                let run = s
                    .run
                    .as_mut()
                    .ok_or_else(|| refused("unknown_run", Value::Null))?;
                if run.terminal.is_some() {
                    return Ok(json!("not_active"));
                }
                if !ignore {
                    run.cancel = true;
                }
                Ok(json!("ack"))
            }
            "run.status" => {
                let quiet = self.state().quiet_stream;
                if quiet {
                    let wait = {
                        let mut state = self.state();
                        let wait = state.quiet_active_probes > 0;
                        state.quiet_active_probes = state.quiet_active_probes.saturating_sub(1);
                        wait
                    };
                    if !wait {
                        self.advance().await;
                    }
                }
                let s = self.state();
                let run = s
                    .run
                    .as_ref()
                    .ok_or_else(|| refused("unknown_run", Value::Null))?;
                let mut status = RunStatus::new("active").with_usage(run.usage.clone());
                if let Some(result) = &run.terminal {
                    status = RunStatus::new(result.state.clone())
                        .with_usage(run.usage.clone())
                        .with_undelivered_steers(vec![]);
                    if let Some(detail) = result.detail.clone() {
                        status = status.with_detail(detail);
                    }
                }
                Ok(serde_json::to_value(status).unwrap())
            }
            "session.retract" => Ok(json!("not_pending")),
            "session.release" => {
                let mut s = self.state();
                let describe: RoleDescribe = serde_json::from_value(s.describe.clone()).unwrap();
                if !describe.declares(caps::SESSION_RETENTION) {
                    return Err(refused("unknown_op", json!({"op": "session.release"})));
                }
                s.release_replies
                    .pop_front()
                    .unwrap_or_else(|| Ok(json!({"state": "deleted"})))
            }
            other => Err(refused("unknown_op", json!({"op": other}))),
        }
    }

    async fn next_unit_of(&mut self, _session: &str) -> Result<Option<Value>, PortError> {
        if self.state().quiet_stream {
            return Ok(None);
        }
        loop {
            {
                let mut s = self.state();
                let open_controls = s.open_controls;
                let Some(run) = s.run.as_mut() else {
                    return Ok(None);
                };
                if let Some(unit) = run.units.pop_front() {
                    return Ok(Some(if open_controls {
                        json!({"kind":"control","event":{"vendor":"opaque","text":"not an answer","usage":"not measured here"}})
                    } else {
                        unit
                    }));
                }
                if run.terminal.is_some() {
                    return Ok(None);
                }
                if run.cancel {
                    Self::terminal(run, "cancelled", None);
                    return Ok(None);
                }
                let hanging = s
                    .steps
                    .get(s.run.as_ref().unwrap().done)
                    .is_some_and(|step| step.hang);
                if hanging {
                    return Ok(None);
                }
            }
            self.advance().await;
        }
    }

    async fn release_of(&mut self, session: &str) {
        self.state().released.push(session.into());
    }
}

fn describe(capabilities: &[&str], max_seconds: u64, delete_within_ms: u64) -> Value {
    let ops = [
        "role.describe",
        "session.baseline",
        "session.send",
        "session.read",
        "run.result",
        "run.status",
        "run.cancel",
        "session.retract",
        "session.subscribe",
    ];
    serde_json::to_value(
        RoleDescribe::new(
            vec![Major::new(
                "llm-runner/v1",
                ops.iter().map(|o| o.to_string()).collect(),
                "stable",
            )],
            "fake-broca",
        )
        .with_capabilities(capabilities.iter().map(|c| c.to_string()).collect())
        .with_session_capabilities_from("admission")
        .with_retention(max_seconds, delete_within_ms)
        .with_run_cancel(vec!["now".into(), "step_boundary".into()]),
    )
    .unwrap()
}

const BASE: &[&str] = &[
    "queue",
    "run_ops",
    "run_status",
    "run_usage",
    "streaming",
    "retention",
    "plans",
    "run_cancel",
    "retract",
    "max_steps",
    "no_tools",
];

struct Fixture {
    _root: tempfile::TempDir,
    handler: Arc<McHandler>,
    scheduler: Arc<SqliteDreamScheduler>,
    context: Arc<TaskContext>,
    control: Arc<Control>,
    effects: Arc<Effects>,
    broca: FakeBroca,
}

impl Fixture {
    /// A fixture whose runner answers `role.describe` with Broca's golden.
    fn golden() -> Self {
        let f = Self::new(&[]);
        f.broca.state().describe = child_runner_describe();
        f
    }

    fn new(capabilities: &[&str]) -> Self {
        // Throwaway roots only; no live store is touched.
        let base = std::env::temp_dir().join("magic-context/i5-c3");
        std::fs::create_dir_all(&base).unwrap();
        let root = tempfile::tempdir_in(base).unwrap();
        let directory = root.path().canonicalize().unwrap();
        let scope = StoreScope {
            project: ProjectId(directory.to_string_lossy().into()),
            session: SessionId("parent".into()),
            generation: Generation(4),
        };
        let scheduler =
            Arc::new(SqliteDreamScheduler::open(root.path().join("scheduler.db"), true).unwrap());
        let task = TaskName::Curate;
        let config = TaskConfig {
            task,
            schedule: "* * * * *".into(),
            has_input: true,
            legacy_last_run_at: None,
        };
        let lease = available(scheduler.claim_task(
            &DreamClaimRequest {
                scope: scope.clone(),
                invocation: InvocationId("invocation-1".into()),
                task: BackgroundTask::Curate,
                domain: task.lease_key(&scope.project.0),
                now_ms: 60_000,
                lease_ms: 120_000,
                token_budget: 1_000,
                manual_force: true,
            },
            task,
            Some(&config),
            |_| true,
        ))
        .unwrap();
        let control = Arc::new(Control {
            lease: AtomicBool::new(true),
            charges: Mutex::default(),
        });
        let context = Arc::new(TaskContext {
            task,
            scope,
            config: Arc::new(CapturedConfig {
                activated: true,
                route: McModuleConfig::default(),
                effective: json!({}),
                harness: "claude-code".into(),
                directory: directory.clone(),
            }),
            domain_lease: DreamDomainLease {
                key: "dreaming".into(),
                holder: "owner".into(),
                generation: 1,
                expires_at_ms: 180_000,
            },
            task_lease: lease,
            cancellation: Cancellation::default(),
            clock: Arc::new(TestClock(AtomicI64::new(60_000))),
            deadline_ms: 180_000,
            control: control.clone(),
        });
        let handler = Arc::new(McHandler::new());
        let broca = FakeBroca {
            state: Arc::new(Mutex::new(State {
                describe: describe(capabilities, 1_000_000, 600_000),
                ..State::default()
            })),
            handler: handler.clone(),
            directory,
        };
        Self {
            _root: root,
            handler,
            scheduler,
            context,
            control,
            effects: Arc::default(),
            broca,
        }
    }

    fn request(&self, tools: &'static [&'static str], max_steps: u32) -> ChildRequest {
        ChildRequest {
            runner: ResolvedRunner {
                kind: HistorianRunnerKind::Broca,
                source: RunnerSource::Configured,
            },
            parent_session_id: "parent".into(),
            directory: self.context.config.directory.clone(),
            agent: "dreamer",
            allowed_tools: tools,
            max_steps,
            model: Some(ModelEntry {
                model: "provider/model/with/slash".into(),
                qualifier: Some("high".into()),
            }),
            system: "system".into(),
            prompt: "prompt".into(),
            timeout: Duration::from_secs(10),
            token_budget: Some(100),
            temperature: None,
        }
    }

    fn carrier(&self, policy: BrocaPolicy) -> BrocaCarrier<FakeBroca> {
        BrocaCarrier::new(
            self.broca.clone(),
            self.handler.broca_dream_tools(),
            self.context.clone(),
            self.effects.clone(),
            self.effects.clone(),
            self.scheduler.clone(),
            policy,
        )
    }

    fn script(&self, steps: Vec<Step>) {
        self.broca.state().steps = steps;
    }

    fn sent(&self) -> Vec<Value> {
        self.broca.ops("session.send")
    }

    fn results(&self, tool: &str) -> Vec<Value> {
        self.broca
            .state()
            .results
            .iter()
            .filter(|(name, _)| name == tool)
            .map(|(_, v)| v.clone())
            .collect()
    }
}

fn policy() -> BrocaPolicy {
    BrocaPolicy {
        module_id: "magic-context".into(),
        require_hard_cap: false,
        privacy_sensitive: false,
    }
}

fn step(input: u64, calls: Vec<(&'static str, Value)>) -> Step {
    Step {
        input,
        calls,
        ..Step::default()
    }
}

fn answer(text: &'static str) -> Step {
    Step {
        input: 1,
        text: Some(text),
        ..Step::default()
    }
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("fake broca fixture timeout")
}

/// Open, complete and close one attempt; returns the completion and session.
async fn run(
    f: &Fixture,
    carrier: &mut BrocaCarrier<FakeBroca>,
    request: &ChildRequest,
) -> (Result<Completion, CarrierError>, String) {
    bounded(async {
        let child = carrier.open(request).await.expect("open");
        let completion = carrier.complete(&child, request).await;
        carrier
            .close(&child, completion.is_ok())
            .await
            .expect("close confirms quiescence");
        assert!(!f.handler.broca_dream_tools().is_live(&child));
        (completion, child)
    })
    .await
}

#[tokio::test]
async fn broca_child_forbidden_tool_never_executes() {
    let f = Fixture::new(BASE);
    // An adversarial runner dispatches a memory tool the child was not given.
    f.broca.state().ignore_allowlist = true;
    f.script(vec![
        step(
            10,
            vec![
                ("ctx_search", json!({"query": "permitted"})),
                (
                    "ctx_memory",
                    json!({"action": "write", "content": "forbidden"}),
                ),
            ],
        ),
        answer("done"),
    ]);
    let request = f.request(&["ctx_search"], 5);
    let (completion, child) = run(&f, &mut f.carrier(policy()), &request).await;
    assert_eq!(completion.unwrap().text, "done");
    assert_eq!(f.effects.executed(), vec!["ctx_search"]);
    assert_eq!(f.results("ctx_search")[0]["ok"], true);
    assert_eq!(
        f.results("ctx_memory")[0]["error"],
        tool_errors::CAPABILITY_NOT_ADMITTED
    );
    // Only the permitted tool was offered in the plan Broca froze.
    let sent = &f.sent()[0];
    assert_eq!(
        sent["plan"]["items"],
        json!([{"provider": "magic-context", "item": "tools", "params": {"tools": ["ctx_search"]}}])
    );
    assert_eq!(f.effects.calls.lock().unwrap()[0].0, child);
}

#[tokio::test]
async fn broca_child_step_overflow_starts_no_next_step() {
    let f = Fixture::new(BASE);
    let write = || ("ctx_memory", json!({"action": "write"}));
    f.script(vec![
        step(1, vec![write()]),
        step(1, vec![write()]),
        step(1, vec![write()]),
        step(1, vec![write()]),
        answer("never"),
    ]);
    let request = f.request(&["ctx_memory"], 2);
    let (completion, _) = run(&f, &mut f.carrier(policy()), &request).await;
    assert_eq!(completion.unwrap_err().message, "max_steps");
    assert_eq!(f.effects.executed().len(), 2, "step 3 must never start");
    assert_eq!(f.sent()[0]["stop_when"], json!({"max_steps": 2}));
}

#[tokio::test]
async fn broca_child_token_cap_stops_run_budget_exhausted() {
    let f = Fixture::golden();
    let write = || ("ctx_memory", json!({"action": "write"}));
    f.script(vec![
        step(60, vec![write()]),
        step(60, vec![write()]),
        step(60, vec![write()]),
        answer("never"),
    ]);
    let request = f.request(&["ctx_memory"], 10);
    let (completion, _) = run(&f, &mut f.carrier(policy()), &request).await;
    assert_eq!(
        completion.unwrap_err().message,
        "token_budget: budget_exhausted limit 100 spent 120 cause limit_reached"
    );
    // Step 2 crossed the cap, so none of its tool calls dispatched.
    assert_eq!(f.effects.executed().len(), 1);
    assert_eq!(f.sent()[0]["budget"], json!({"max_input_tokens": 100}));
}

#[tokio::test]
async fn broca_child_without_cap_capability_sends_no_cap_and_stops_from_usage() {
    let f = Fixture::new(BASE);
    let write = || ("ctx_memory", json!({"action": "write"}));
    f.script(vec![
        step(60, vec![write()]),
        step(60, vec![write()]),
        step(60, vec![write()]),
        answer("never"),
    ]);
    let request = f.request(&["ctx_memory"], 10);
    let (completion, _) = run(&f, &mut f.carrier(policy()), &request).await;
    // A runner without input_token_cap must not receive the field at all.
    assert!(f.sent()[0].get("budget").is_none());
    // The documented overshoot: step 2 starts under the budget, then its usage
    // stops the attempt; later memory calls are refused and the run cancelled.
    assert_eq!(completion.unwrap_err().message, "token_budget");
    assert_eq!(f.effects.executed().len(), 2);
    assert_eq!(f.broca.ops("run.cancel")[0]["at"], "step_boundary");
}

#[tokio::test]
async fn broca_child_without_input_token_cap_is_unavailable_when_hard_cap_required() {
    let f = Fixture::new(BASE);
    f.script(vec![answer("done")]);
    let request = f.request(&["ctx_memory"], 3);
    let mut strict = f.carrier(BrocaPolicy {
        require_hard_cap: true,
        ..policy()
    });
    let refused = bounded(strict.open(&request)).await.unwrap_err();
    assert_eq!(refused.message, "unavailable: input_token_cap");
    assert!(f.sent().is_empty(), "no prompt may leave Rust");
    // Permitted control: the same runner serves a task that accepts the overshoot.
    let (completion, _) = run(&f, &mut f.carrier(policy()), &request).await;
    assert_eq!(completion.unwrap().text, "done");
    assert_eq!(f.sent().len(), 1);
}

#[tokio::test]
async fn broca_child_lease_loss_refuses_tool() {
    let f = Fixture::new(BASE);
    let control = f.control.clone();
    f.broca.state().on_step = Some(Box::new(move |index| {
        if index == 1 {
            control.lease.store(false, Ordering::SeqCst);
        }
    }));
    let write = || ("ctx_memory", json!({"action": "write"}));
    f.script(vec![
        step(1, vec![write()]),
        step(1, vec![write()]),
        answer("never"),
    ]);
    let request = f.request(&["ctx_memory"], 10);
    let (completion, _) = run(&f, &mut f.carrier(policy()), &request).await;
    assert_eq!(completion.unwrap_err().message, "LeaseLost");
    assert_eq!(
        f.effects.executed().len(),
        1,
        "only the call before the loss ran"
    );
    let refused = &f.results("ctx_memory")[1];
    assert_eq!(refused["error"], tool_errors::TOOL_UNAVAILABLE);
    assert_eq!(refused["message"], "LeaseLost");
    assert_eq!(f.broca.ops("run.cancel")[0]["at"], "step_boundary");
}

#[tokio::test]
async fn broca_child_cancel_during_open_sends_nothing() {
    let f = Fixture::new(BASE);
    let gate = Arc::new(tokio::sync::Notify::new());
    f.broca.state().gate = Some(gate.clone());
    let request = f.request(&["ctx_memory"], 3);
    let mut carrier = f.carrier(policy());
    let opened = bounded(async {
        let open = carrier.open(&request);
        let cancel = async {
            while f.broca.ops("role.describe").is_empty() {
                tokio::task::yield_now().await;
            }
            f.context.cancellation.cancel();
            gate.notify_one();
        };
        tokio::join!(open, cancel).0
    })
    .await;
    assert_eq!(opened.unwrap_err().message, "Cancelled");
    assert!(
        f.sent().is_empty(),
        "a cancelled open never sends the prompt"
    );
    let session = f.broca.state().log[0].0.clone();
    assert!(session.starts_with(SESSION_PREFIX));
    assert!(!f.handler.broca_dream_tools().is_live(&session));
    // A runner calling the abandoned session reaches no router and no foreground tool.
    f.broca
        .send(
            &session,
            json!({"prompt": "p", "send_id": "probe", "tools": []}),
        )
        .unwrap();
    let late = f
        .broca
        .dispatch("ctx_memory", &json!({"action": "write"}), "lineage-9:1")
        .await;
    assert_eq!(late["error"], tool_errors::TOOL_UNAVAILABLE);
    assert!(f.effects.executed().is_empty());
}

#[tokio::test]
async fn broca_child_indeterminate_tool_outcome_is_never_redispatched() {
    let f = Fixture::new(BASE);
    {
        let mut s = f.broca.state();
        s.lose_tool_reply = Some(0);
        s.redispatch = true;
    }
    f.script(vec![
        step(1, vec![("ctx_memory", json!({"action": "write"}))]),
        answer("never"),
    ]);
    let request = f.request(&["ctx_memory"], 5);
    let (completion, _) = run(&f, &mut f.carrier(policy()), &request).await;
    let failure = completion.unwrap_err();
    assert_eq!(failure.message, "interrupted");
    assert!(
        !failure.retryable,
        "no fallback attempt may redo the effect"
    );
    // The misbehaving re-dispatch got the recorded answer, not a second effect.
    assert_eq!(f.effects.executed().len(), 1);
    let results = f.results("ctx_memory");
    assert_eq!(results[0], results[1]);
    assert_eq!(f.sent().len(), 1, "the prompt is never resent");
}

#[tokio::test]
async fn broca_child_without_model_is_refused() {
    let f = Fixture::new(BASE);
    let mut request = f.request(&[], 3);
    request.model = None;
    let refused = bounded(f.carrier(policy()).open(&request))
        .await
        .unwrap_err();
    assert_eq!(refused.message, "unavailable: model_required");
    assert!(f.broca.state().log.is_empty());
}

#[tokio::test]
async fn broca_child_requires_configured_broca() {
    let f = Fixture::new(BASE);
    for runner in [
        ResolvedRunner {
            kind: HistorianRunnerKind::Broca,
            source: RunnerSource::HarnessDefault,
        },
        ResolvedRunner {
            kind: HistorianRunnerKind::Host,
            source: RunnerSource::Configured,
        },
    ] {
        let mut request = f.request(&[], 3);
        request.runner = runner;
        let refused = bounded(f.carrier(policy()).open(&request))
            .await
            .unwrap_err();
        assert_eq!(refused.message, "unavailable: broca_not_configured");
    }
    assert!(f.broca.state().log.is_empty());
}

#[tokio::test]
async fn broca_child_lost_send_reply_resends_identical_send_only() {
    let f = Fixture::new(BASE);
    f.broca.state().lose_send_replies = 1;
    f.script(vec![answer("done")]);
    let request = f.request(&[], 3);
    let (completion, child) = run(&f, &mut f.carrier(policy()), &request).await;
    assert_eq!(completion.unwrap().text, "done");
    let sent = f.sent();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0], sent[1]);
    assert_eq!(sent[0]["send_id"], child);
    assert_eq!(
        sent[0]["model"],
        json!({"provider": "provider", "model": "model/with/slash", "variant": "high"})
    );
    assert_eq!(sent[0]["tools"], json!([]));
    assert!(sent[0].get("temperature").is_none());
    assert_eq!(f.broca.state().released, vec![child]);
}

#[tokio::test]
async fn broca_child_sends_retention_and_private_dreams_use_the_shortest() {
    let f = Fixture::new(BASE);
    f.script(vec![answer("done")]);
    let request = f.request(&[], 3);
    run(&f, &mut f.carrier(policy()), &request).await.0.unwrap();
    assert_eq!(f.sent()[0]["retention"], ORDINARY_RETENTION_SECONDS);
    let private = BrocaPolicy {
        privacy_sensitive: true,
        ..policy()
    };
    let g = Fixture::new(BASE);
    g.script(vec![answer("done")]);
    run(&g, &mut g.carrier(private.clone()), &g.request(&[], 3))
        .await
        .0
        .unwrap();
    assert_eq!(
        g.sent()[0]["retention"],
        10 + PRIVATE_RETENTION_SLACK_SECONDS
    );
    // A runner that deletes too slowly, or declares no retention, gets nothing.
    let slow = Fixture::new(BASE);
    slow.broca.state().describe = describe(BASE, 1_000_000, PRIVATE_DELETE_WITHIN_MS + 1);
    let refused = bounded(slow.carrier(private).open(&slow.request(&[], 3)))
        .await
        .unwrap_err();
    assert_eq!(refused.message, "unavailable: retention_deletion_too_slow");
    let none = Fixture::new(&[
        "queue",
        "run_ops",
        "streaming",
        "run_cancel",
        "retract",
        "run_status",
        "max_steps",
        "no_tools",
    ]);
    let refused = bounded(none.carrier(policy()).open(&none.request(&[], 3)))
        .await
        .unwrap_err();
    assert_eq!(refused.message, "unavailable: retention");
    assert!(slow.sent().is_empty() && none.sent().is_empty());
}

#[tokio::test]
async fn broca_child_close_requires_terminal_quiescence() {
    for ignore_cancel in [false, true] {
        let f = Fixture::new(BASE);
        f.broca.state().ignore_cancel = ignore_cancel;
        f.script(vec![Step {
            hang: true,
            ..Step::default()
        }]);
        let request = f.request(&["ctx_memory"], 3);
        let mut carrier = f.carrier(policy());
        let child = bounded(carrier.open(&request)).await.unwrap();
        // The attempt times out with its run still active.
        let timed_out = tokio::time::timeout(
            Duration::from_millis(50),
            carrier.complete(&child, &request),
        )
        .await;
        assert!(timed_out.is_err());
        let closed = tokio::time::timeout(Duration::from_secs(4), carrier.close(&child, false))
            .await
            .unwrap();
        assert_eq!(f.broca.ops("run.cancel")[0]["at"], "step_boundary");
        if ignore_cancel {
            assert_eq!(closed.unwrap_err().message, "cleanup_unknown");
            assert!(f.broca.state().released.is_empty());
        } else {
            closed.unwrap();
            assert_eq!(f.broca.state().released, vec![child.clone()]);
        }
        // Either way, no memory tool runs after close begins.
        let late = f
            .broca
            .dispatch("ctx_memory", &json!({"action": "write"}), "lineage-1:99")
            .await;
        assert_eq!(late["error"], tool_errors::TOOL_UNAVAILABLE);
        assert!(f.effects.executed().is_empty());
        assert!(f.broca.ops("session.delete").is_empty());
    }
}

async fn status(f: &Fixture) -> Value {
    f.broca
        .clone()
        .call("probe", "run.status", json!({"run_id": "run-1"}))
        .await
        .unwrap()["result"]
        .clone()
}

#[tokio::test]
async fn broca_child_budget_exhausted_is_the_task_budget_failure() {
    let f = Fixture::golden();
    let write = || ("ctx_memory", json!({"action": "write"}));
    // 50 + 50 reaches the cap of 100 exactly, which stops the run.
    f.script(vec![
        step(50, vec![write()]),
        step(50, vec![write()]),
        answer("never"),
    ]);
    let route = McModuleConfig {
        dreamer_runner: Some(HistorianRunnerKind::Broca),
        ..McModuleConfig::default()
    };
    let trusted = json!({"dreamer": {"pi": {"model": "provider/primary",
        "fallback_models": ["provider/fallback"]}}});
    let directory = f.context.config.directory.clone();
    let request = DreamRequest {
        task: "curate",
        role: DreamRole::Curate,
        harness: "pi",
        parent_session_id: "parent",
        directory: &directory,
        system: "system",
        prompt: "prompt",
        timeout: Duration::from_secs(10),
        token_budget: Some(100),
        allow_empty: false,
    };
    let mut carrier = f.carrier(policy());
    let report = bounded(run_dream_task(
        true,
        &route,
        &trusted,
        &request,
        &mut carrier,
        |_| Ok(()),
    ))
    .await;
    assert_eq!(
        report.result.unwrap_err(),
        Failure::Transport(
            "token_budget: budget_exhausted limit 100 spent 100 cause limit_reached".into()
        )
    );
    // Final for the task: the fallback model is never tried.
    assert_eq!(report.attempts.len(), 1);
    assert_eq!(f.sent().len(), 1);
    assert_eq!(f.effects.executed().len(), 1);
    let mut observed = status(&f).await;
    let usage: RunUsage =
        serde_json::from_value(observed.as_object_mut().unwrap().remove("usage").unwrap()).unwrap();
    assert!(usage.consistent());
    assert_eq!(
        (usage.steps, usage.input_tokens, usage.output_tokens),
        (2, Some(100), Some(1000))
    );
    assert_eq!(
        observed,
        json!({"state": "budget_exhausted", "detail": {"limit": 100, "spent": 100, "cause": "limit_reached"},
            "undelivered_steers": []})
    );
}

#[tokio::test]
async fn broca_child_usage_unreported_stops_without_a_guessed_charge() {
    let f = Fixture::golden();
    let write = || ("ctx_memory", json!({"action": "write"}));
    f.script(vec![
        step(30, vec![write()]),
        Step {
            input: 40,
            unreported: true,
            calls: vec![write()],
            ..Step::default()
        },
        answer("never"),
    ]);
    let request = f.request(&["ctx_memory"], 10);
    let (completion, _) = run(&f, &mut f.carrier(policy()), &request).await;
    let failure = completion.unwrap_err();
    assert_eq!(
        failure.message,
        "token_budget: budget_exhausted limit 100 spent 30 cause usage_unreported"
    );
    assert!(!failure.retryable);
    // Only the measured step was charged; the unreported one is not counted as anything.
    let charges = f.control.charges.lock().unwrap().clone();
    assert_eq!(charges.len(), 1, "{charges:?}");
    assert_eq!(charges[0].1.input, 30);
    assert_eq!(f.effects.executed().len(), 1);
    assert_eq!(
        status(&f).await["detail"],
        json!({"limit": 100, "spent": 30, "cause": "usage_unreported"})
    );
}

#[tokio::test]
async fn broca_child_never_executed_results_produce_no_effect() {
    let f = Fixture::golden();
    f.script(vec![
        step(
            120,
            vec![
                ("ctx_memory", json!({"action": "write"})),
                ("ctx_memory", json!({"action": "archive"})),
            ],
        ),
        answer("never"),
    ]);
    let request = f.request(&["ctx_memory"], 10);
    let (completion, _) = run(&f, &mut f.carrier(policy()), &request).await;
    assert!(completion
        .unwrap_err()
        .message
        .starts_with("token_budget: budget_exhausted"));
    assert_eq!(f.broca.state().never_executed.len(), 2);
    assert!(f.effects.executed().is_empty());
    assert!(!f
        .effects
        .observations
        .lock()
        .unwrap()
        .iter()
        .any(|(_, e)| matches!(e, ChildEvent::Receipt(_))));
}

#[test]
fn broca_goldens_match_their_pinned_checksums() {
    use sha2::{Digest, Sha256};
    assert_eq!(
        format!("{:x}", Sha256::digest(GOLDEN_DESCRIBE)),
        GOLDEN_DESCRIBE_SHA256
    );
    assert_eq!(
        format!("{:x}", Sha256::digest(GOLDEN_EXHAUSTED)),
        GOLDEN_EXHAUSTED_SHA256
    );
    let describe = check_describe(&child_runner_describe()).unwrap();
    assert!(describe.declares(caps::INPUT_TOKEN_CAP));
}

/// Broca 0.7 admission: the two new groups change nothing the dreamer
/// negotiates. Both captures decode and negotiate the same retention, token
/// cap and cancel point for the same request.
#[test]
fn broca_0_7_describe_negotiates_the_dream_child_unchanged() {
    let load = |name: &str| {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("testdata")
            .join("broca-0.7")
            .join(name);
        let reply: Value = serde_json::from_slice(&std::fs::read(&path).expect("read fixture"))
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let answer = crate::session_resolver::read_runner_reply(reply).expect("envelope");
        check_describe(&answer).unwrap_or_else(|problems| panic!("{name}: {problems:?}"))
    };
    let before = load("role.describe.before.json");
    let after = load("role.describe.after.json");
    let fixture = Fixture::new(&[]);
    let carrier = fixture.carrier(policy());
    let request = fixture.request(&["ctx_memory"], 3);
    let negotiated = |describe: &RoleDescribe| {
        carrier
            .negotiate(describe, &request, Some(100))
            .unwrap_or_else(|error| panic!("{error:?}"))
    };
    assert_eq!(negotiated(&before), negotiated(&after));
}

#[tokio::test]
async fn broca_child_golden_runner_stops_at_exactly_the_cap() {
    let f = Fixture::golden();
    // Broca's golden exhausted run: 5 input + 2 cache-read + 3 cache-write = cap 10.
    f.script(vec![
        Step {
            input: 5,
            cache_read: 2,
            cache_write: 3,
            calls: vec![("ctx_memory", json!({"action": "write"}))],
            ..Step::default()
        },
        answer("never"),
    ]);
    let mut request = f.request(&["ctx_memory"], 10);
    request.token_budget = Some(10);
    // The golden runner deletes within an hour, so even a private dream is admitted.
    let private = BrocaPolicy {
        privacy_sensitive: true,
        require_hard_cap: true,
        ..policy()
    };
    let (completion, _) = run(&f, &mut f.carrier(private), &request).await;
    let failure = completion.unwrap_err();
    assert_eq!(
        failure.message,
        "token_budget: budget_exhausted limit 10 spent 10 cause limit_reached"
    );
    assert!(!failure.retryable);
    assert_eq!(f.sent()[0]["budget"], json!({"max_input_tokens": 10}));
    assert!(f.effects.executed().is_empty());
    assert_eq!(f.broca.state().never_executed.len(), 1);
    let charged = f.control.charges.lock().unwrap()[0].1.clone();
    assert_eq!(
        (charged.input, charged.cache_read, charged.cache_write),
        (5, 2, 3)
    );
    // This golden predates the role's cumulative run_usage shape. Keep comparing
    // its state/detail fields; current usage is asserted independently.
    let mut golden: Value = serde_json::from_slice(GOLDEN_EXHAUSTED).unwrap();
    golden.as_object_mut().unwrap().remove("usage");
    let golden: RunStatus = serde_json::from_value(golden).unwrap();
    let fake: RunStatus = serde_json::from_value(status(&f).await).unwrap();
    assert_eq!(fake.state, golden.state);
    assert_eq!(fake.detail, golden.detail);
    assert_eq!(fake.undelivered_steers, golden.undelivered_steers);
}

const CAP_CASES: &str = include_str!("golden/llm-runner-conformance-0.4.0/input_token_cap.rs.txt");
const CAP_CASES_SHA256: &str = "2b28df81080ec88199cb984f907e58ce1e0c0fe7dc1c02ba948cb55ef2f4084f";

#[test]
fn broca_conformance_cap_cases_are_pinned() {
    use sha2::{Digest, Sha256};
    assert_eq!(format!("{:x}", Sha256::digest(CAP_CASES)), CAP_CASES_SHA256);
    for case in [
        "input_token_cap_at_limit",
        "input_token_cap_crossing_tools",
        "input_token_cap_usage_unreported",
        "input_token_cap_raise_refused",
        "input_token_cap_closed_members",
    ] {
        assert!(CAP_CASES.contains(&format!("\"{case}\"")), "{case}");
    }
    // The sixth case, input_token_cap_restart_between_episodes, is named in the
    // conformance crate's src/runner.rs, which calls the vendored file's
    // `restart` function, so that function stands in for the name here.
    assert!(CAP_CASES.contains("pub async fn restart<S>("));
}

/// One capped attempt on the golden runner; answers the failure, the number of
/// model steps that started and the memory effects.
async fn capped(cap: u64, steps: Vec<Step>) -> (CarrierError, usize, usize, usize) {
    let f = Fixture::golden();
    f.script(steps);
    let mut request = f.request(&["ctx_memory"], 10);
    request.token_budget = Some(cap);
    let (completion, _) = run(&f, &mut f.carrier(policy()), &request).await;
    let started = f.broca.state().run.as_ref().unwrap().done;
    let never = f.broca.state().never_executed.len();
    (
        completion.unwrap_err(),
        started,
        f.effects.executed().len(),
        never,
    )
}

fn metered(input: u64, read: u64, write: u64, calls: usize, unreported: bool) -> Step {
    Step {
        input,
        cache_read: read,
        cache_write: write,
        unreported,
        calls: (0..calls)
            .map(|i| ("ctx_memory", json!({"action": "write", "n": i})))
            .collect(),
        text: (calls == 0).then_some("text"),
        ..Step::default()
    }
}

/// The carrier-visible conformance cases, with the conformance crate's numbers.
/// The raise, closed-member and restart cases govern later sends on one session;
/// this carrier makes one capped first send per fresh session, and the fake
/// enforces those rules with the role crate's `Budget::check`.
#[tokio::test]
async fn broca_child_conformance_cap_cases_hold_through_the_carrier() {
    // input_token_cap_at_limit: 1+2+3 reaches cap 6; the second step never starts.
    let (failure, started, executed, _) = capped(
        6,
        vec![metered(1, 2, 3, 0, false), metered(1, 0, 0, 0, false)],
    )
    .await;
    assert_eq!(
        failure.message,
        "token_budget: budget_exhausted limit 6 spent 6 cause limit_reached"
    );
    assert_eq!((started, executed), (1, 0));
    // input_token_cap_crossing_tools: the under-cap tool runs once, both calls of
    // the crossing step get never-executed results, spent counts the crossing step.
    let (failure, started, executed, never) = capped(
        10,
        vec![
            metered(1, 1, 1, 1, false),
            metered(2, 3, 5, 2, false),
            metered(1, 0, 0, 0, false),
        ],
    )
    .await;
    assert_eq!(
        failure.message,
        "token_budget: budget_exhausted limit 10 spent 13 cause limit_reached"
    );
    assert_eq!((started, executed, never), (2, 1, 2));
    // input_token_cap_usage_unreported: the unmeasured step is not counted.
    let (failure, started, executed, never) = capped(
        10,
        vec![
            metered(1, 1, 1, 1, false),
            metered(2, 3, 5, 2, true),
            metered(1, 0, 0, 0, false),
        ],
    )
    .await;
    assert_eq!(
        failure.message,
        "token_budget: budget_exhausted limit 10 spent 3 cause usage_unreported"
    );
    assert!(!failure.retryable);
    assert_eq!((started, executed, never), (2, 1, 2));
}

mod executor;

mod routed;

mod session_runner;

mod session_retention;

#[tokio::test]
async fn broca_child_open_controls_follow_status_and_result_without_parsing_bodies() {
    let mut completions = Vec::new();
    for open_controls in [false, true] {
        let f = Fixture::new(BASE);
        f.broca.state().open_controls = open_controls;
        f.script(vec![answer("pinned final answer")]);
        let request = f.request(&[], 3);
        let (completion, _) = run(&f, &mut f.carrier(policy()), &request).await;
        let completion = completion.unwrap();
        assert_eq!(completion.text, "pinned final answer");
        assert_eq!(f.broca.ops("run.status").len(), 1);
        assert_eq!(f.broca.ops("run.result").len(), 1);
        completions.push((completion.text, completion.usage));
    }
    assert_eq!(completions[0], completions[1]);
}

#[tokio::test]
async fn broca_child_quiet_stream_polls_state_before_reading_one_terminal_result() {
    let f = Fixture::new(BASE);
    {
        let mut state = f.broca.state();
        state.quiet_stream = true;
        state.quiet_active_probes = 2;
    }
    f.script(vec![answer("quiet final answer")]);
    let request = f.request(&[], 3);
    let (completion, _) = run(&f, &mut f.carrier(policy()), &request).await;
    assert_eq!(completion.unwrap().text, "quiet final answer");
    assert_eq!(f.broca.ops("run.status").len(), 3);
    assert_eq!(f.broca.ops("run.result").len(), 1);
}

#[tokio::test]
async fn broca_child_missing_follow_groups_are_refused_without_a_send() {
    for missing in [caps::RUN_OPS, caps::RUN_STATUS] {
        let groups: Vec<_> = BASE
            .iter()
            .copied()
            .filter(|group| *group != missing)
            .collect();
        let f = Fixture::new(&groups);
        let error = bounded(f.carrier(policy()).open(&f.request(&[], 3)))
            .await
            .unwrap_err();
        assert!(error.message.contains(missing), "{error:?}");
        assert!(f.sent().is_empty());
    }
}

#[tokio::test]
async fn broca_child_bare_describe_reply_is_refused_by_name_without_a_send() {
    let f = Fixture::new(BASE);
    f.broca.state().bare_replies = true;
    let error = bounded(f.carrier(policy()).open(&f.request(&[], 3)))
        .await
        .unwrap_err();
    assert!(
        error
            .message
            .starts_with("role.describe: runner_reply_shape"),
        "{error:?}"
    );
    assert!(f.sent().is_empty(), "no prompt may leave Rust");
}

#[tokio::test]
async fn broca_child_bare_send_reply_is_refused_by_name() {
    let f = Fixture::new(BASE);
    f.script(vec![answer("done")]);
    let request = f.request(&[], 3);
    let mut carrier = f.carrier(policy());
    let child = bounded(carrier.open(&request)).await.expect("open");
    // Discovery was answered wrapped; the send's reply comes back bare.
    f.broca.state().bare_replies = true;
    let error = bounded(carrier.complete(&child, &request))
        .await
        .unwrap_err();
    assert!(
        error
            .message
            .starts_with("session.send: runner_reply_shape"),
        "{error:?}"
    );
    assert_eq!(f.sent().len(), 1);
}

#[tokio::test]
async fn broca_session_change_send_goldens_start_the_dream_child() {
    for stem in ["send_reply.admission", "send_reply.session_class"] {
        for suffix in ["before", "after"] {
            let name = format!("send-reply-goldens/{stem}.json.{suffix}");
            let f = Fixture::new(BASE);
            f.broca.state().send_reply = Some(crate::broca_session_change_tests::sample(&name));
            let request = f.request(&[], 3);
            let mut carrier = f.carrier(policy());
            let child = bounded(carrier.open(&request)).await.expect("open");
            bounded(carrier.start(&child))
                .await
                .unwrap_or_else(|error| panic!("{name}: {error:?}"));
            assert_eq!(
                carrier.attempt.as_ref().unwrap().run_id.as_deref(),
                Some("run-1")
            );
            assert_eq!(f.sent().len(), 1);
        }
    }
}

#[tokio::test]
async fn broca_session_change_describe_opens_the_dream_child() {
    let f = Fixture::new(BASE);
    f.broca.state().describe = crate::session_resolver::read_runner_reply(
        crate::broca_session_change_tests::sample("role.describe.session_change.json"),
    )
    .unwrap();
    let request = f.request(&[], 3);
    let mut carrier = f.carrier(policy());
    bounded(carrier.open(&request)).await.expect("open");
    assert!(f.sent().is_empty());
}
