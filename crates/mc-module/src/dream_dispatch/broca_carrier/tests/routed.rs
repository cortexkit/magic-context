//! The routed dream carrier end to end, with fakes for everything outside
//! ck-mc: a routing/v1 provider that answers candidates in order and honours
//! `exclude`, Entorhinal's project lookup, the daemon's `scope.sync`, and three
//! runners, all on the fake Broca's llm-runner wire:
//!
//! - `broca` admits a project-scoped session with no parent under any harness;
//! - `thalamus-harness` admits one only bound to harness `opencode`, and refuses
//!   any other harness by name before any work (`invalid_params`,
//!   `detail.field: harness`), as THALAMUS's OpenCode runner does;
//! - `claude-gateway` refuses every module-launched session by name, as a runner
//!   that hosts only person-started sessions does.

use super::*;
mod live_shape;
use crate::config_parity::{
    ConfigResolveRequest, CoreConfig, CoreConfigResolver, ProtectedTokenTiers, TrustFlags,
};
use crate::dream_dispatch::dispatcher::{DispatchOutcome, Dispatcher};
use crate::dream_dispatch::executor::{DreamExecutor, NoBroca, Transport};
use crate::dream_dispatch::routed::carrier::{
    RoutedCarrier, RoutedCarrierParts, RoutedParks, HARNESS_UNKNOWN,
};
use crate::dream_dispatch::routed::fetch_plan::{self, Provider};
use crate::dream_dispatch::routed::scope::{DreamScope, EntorhinalProjectId};
use crate::dream_dispatch::routed::wire::{DreamWire, RunnerBind, WireRefusal, SCOPE_UNSUPPORTED};
use crate::dream_dispatch::tick::{ManualRun, RunReport, PROJECT_UNRESOLVED};
use crate::model_work::RoutingCatalog;
use cortexkit_role_routing::errors::{NoRouteReason, Refusal};
use cortexkit_role_routing::report::{Outcome, ReportAnswer, ReportRequest};
use cortexkit_role_routing::select::SelectRequest;
use mc_store::dream_scheduler::schedules::RunStatus as ScheduleStatus;
use mc_store::McStore;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use subc_client_rs::async_trait;
use subc_protocol::scope::ScopeKind;
use subc_protocol::Principal;

const PROVIDER: &str = "routing";
const ENTORHINAL_ID: &str = "pj-entorhinal";
const CODE_PROVIDER: &str = "fixture-code-reader";

/// One answer the fake routing provider can give.
#[derive(Clone)]
struct Candidate {
    module: &'static str,
    provider: &'static str,
    model: &'static str,
    /// The harness the runner declared for this route, as routing/v1 0.2.1's
    /// `runner.harness` carries it; `None` when the runner declares none.
    harness: Option<&'static str>,
}

fn candidate(
    module: &'static str,
    model: &'static str,
    harness: Option<&'static str>,
) -> Candidate {
    Candidate {
        module,
        provider: "vendor",
        model,
        harness,
    }
}

#[derive(Default)]
struct WireLog {
    events: Vec<String>,
    syncs: Vec<DreamScope>,
    ends: Vec<String>,
    selects: Vec<(String, Value)>,
    reports: Vec<(String, ReportRequest)>,
    /// Every runner op: the scope it ran under, its binding and the op.
    ops: Vec<(DreamScope, RunnerBind, String)>,
    lookups: Vec<PathBuf>,
    /// For each select, whether the task's domain lease was still held.
    lease_held: Vec<bool>,
    capabilities: Vec<Vec<String>>,
    plans: Vec<Value>,
}

type Probe = Box<dyn Fn() -> bool + Send + Sync>;

struct FakeWire {
    support: bool,
    providers: Vec<String>,
    projects: Mutex<HashMap<PathBuf, String>>,
    candidates: Mutex<Vec<Candidate>>,
    /// Answer every select `no_route` with this reset time.
    timed_reset: Mutex<Option<u64>>,
    runners: HashMap<&'static str, FakeBroca>,
    log: Mutex<WireLog>,
    decisions: AtomicU64,
    lease_probe: Mutex<Option<Probe>>,
    tool_unavailable: Mutex<bool>,
    old_routing: Mutex<bool>,
}

impl FakeWire {
    fn new(handler: &Arc<McHandler>, directory: &Path, describe: Value) -> Self {
        let runner = |steps: Vec<Step>| FakeBroca {
            state: Arc::new(Mutex::new(State {
                describe: describe.clone(),
                steps,
                ..State::default()
            })),
            handler: handler.clone(),
            directory: directory.to_path_buf(),
        };
        Self {
            support: true,
            providers: vec![PROVIDER.into()],
            projects: Mutex::new(HashMap::from([(
                directory.to_path_buf(),
                ENTORHINAL_ID.to_owned(),
            )])),
            candidates: Mutex::default(),
            timed_reset: Mutex::default(),
            runners: HashMap::from([
                ("broca", runner(Vec::new())),
                ("thalamus-harness", runner(Vec::new())),
                ("claude-gateway", runner(Vec::new())),
            ]),
            log: Mutex::default(),
            decisions: AtomicU64::new(0),
            lease_probe: Mutex::default(),
            tool_unavailable: Mutex::default(),
            old_routing: Mutex::default(),
        }
    }

    fn offer(&self, candidates: Vec<Candidate>) {
        *self.candidates.lock().unwrap() = candidates;
    }

    /// Script every runner's model steps.
    fn script(&self, steps: Vec<Step>) {
        for runner in self.runners.values() {
            runner.state().steps = steps.clone();
        }
    }

    fn log(&self) -> std::sync::MutexGuard<'_, WireLog> {
        self.log.lock().unwrap()
    }

    fn sends(&self) -> Vec<(DreamScope, RunnerBind)> {
        self.log()
            .ops
            .iter()
            .filter(|(_, _, op)| op == "session.send")
            .map(|(scope, bind, _)| (scope.clone(), bind.clone()))
            .collect()
    }

    fn runner_ops(&self) -> usize {
        self.log().ops.len()
    }
}

fn refusal(code: &str, field: &str) -> PortError {
    refused(code, json!({"field": field}))
}

#[async_trait]
impl DreamWire for FakeWire {
    fn scope_support(&self) -> Result<(), WireRefusal> {
        if self.support {
            Ok(())
        } else {
            Err(WireRefusal {
                code: SCOPE_UNSUPPORTED.into(),
                detail: "fake".into(),
            })
        }
    }

    async fn lookup_project(&self, workdir: &Path) -> Option<EntorhinalProjectId> {
        self.log().lookups.push(workdir.to_path_buf());
        let answer = self.projects.lock().unwrap().get(workdir).cloned()?;
        EntorhinalProjectId::from_lookup_answer(&answer)
    }

    async fn sync_scope(&self, scope: &DreamScope) -> Result<(), WireRefusal> {
        let mut log = self.log();
        log.events.push("sync".into());
        log.syncs.push(scope.clone());
        Ok(())
    }

    async fn end_scope(&self, scope: &DreamScope) -> Result<(), WireRefusal> {
        let mut log = self.log();
        log.events.push("end".into());
        log.ends.push(scope.scope_ref().to_owned());
        Ok(())
    }

    async fn routing_catalog(&self) -> RoutingCatalog {
        RoutingCatalog {
            generation: 1,
            providers: self.providers.clone(),
        }
    }

    async fn tool_providers(
        &self,
        _: &DreamScope,
        capabilities: &[&str],
    ) -> Result<Vec<Provider>, WireRefusal> {
        self.log()
            .capabilities
            .push(capabilities.iter().map(|s| (*s).to_owned()).collect());
        capabilities
            .iter()
            .map(|tag| {
                let module = match *tag {
                    fetch_plan::CODE_READ => CODE_PROVIDER,
                    fetch_plan::MEMORY | fetch_plan::SEARCH => "magic-context",
                    _ => {
                        return Err(WireRefusal {
                            code: "tool_unavailable".into(),
                            detail: tag.to_string(),
                        })
                    }
                };
                Ok(Provider {
                    capability: tag.to_string(),
                    module: module.into(),
                })
            })
            .collect()
    }

    async fn select(
        &self,
        scope: &DreamScope,
        provider: &str,
        request: &SelectRequest,
    ) -> Result<Value, Refusal> {
        assert_eq!(provider, PROVIDER);
        let held = self
            .lease_probe
            .lock()
            .unwrap()
            .as_ref()
            .map(|probe| probe());
        {
            let mut log = self.log();
            log.events.push("select".into());
            log.selects.push((
                scope.scope_ref().to_owned(),
                serde_json::to_value(request).unwrap(),
            ));
            log.lease_held.extend(held);
        }
        if *self.old_routing.lock().unwrap() && request.requirements.tool_capabilities.is_some() {
            return Err(Refusal::invalid_requirements(
                "tool_capabilities",
                "unsupported requirement",
            ));
        }
        if let Some(reset) = *self.timed_reset.lock().unwrap() {
            return Err(Refusal::no_route(
                NoRouteReason::NoAvailableModel,
                Some(reset),
            ));
        }
        let excluded = request.exclude.clone().unwrap_or_default();
        let Some(chosen) = self
            .candidates
            .lock()
            .unwrap()
            .iter()
            .find(|c| !excluded.contains(&format!("{}/{}", c.provider, c.model)))
            .cloned()
        else {
            return Err(Refusal::no_route(NoRouteReason::NoAvailableModel, None));
        };
        let decision = self.decisions.fetch_add(1, Ordering::SeqCst) + 1;
        let mut runner = json!({"module": chosen.module,
            "model": {"provider": chosen.provider, "model": chosen.model}});
        if let Some(harness) = chosen.harness {
            runner["harness"] = json!(harness);
        }
        Ok(json!({
            "decision_id": format!("decision-{decision}"),
            "route": {"provider": chosen.provider, "model": chosen.model},
            "runner": runner,
            "context_window": 200_000,
            "max_output_tokens": 8_000,
            "expires_at_ms": crate::now_ms() as u64 + 600_000,
            "explanation": "first candidate not excluded",
        }))
    }

    async fn report(
        &self,
        scope: &DreamScope,
        _: &str,
        request: &ReportRequest,
    ) -> Result<ReportAnswer, Refusal> {
        {
            let mut log = self.log();
            log.events.push("report".into());
            log.reports
                .push((scope.scope_ref().to_owned(), request.clone()));
        }
        Ok(serde_json::from_value(json!({
            "decision_id": request.decision_id,
            "report_id": format!("report-{}", request.decision_id),
            "outcome": request.outcome,
        }))
        .unwrap())
    }

    async fn runner_call(
        &self,
        scope: &DreamScope,
        bind: &RunnerBind,
        op: &str,
        params: Value,
    ) -> Result<Value, PortError> {
        {
            let mut log = self.log();
            log.events.push(op.to_owned());
            log.ops.push((scope.clone(), bind.clone(), op.to_owned()));
        }
        if op == "session.send" {
            self.log()
                .plans
                .push(params.get("plan").cloned().unwrap_or(Value::Null));
            if *self.tool_unavailable.lock().unwrap() {
                return Err(refusal("tool_unavailable", "plan"));
            }
        }
        match bind.module.as_str() {
            "thalamus-harness" if bind.harness != "opencode" => {
                return Err(refusal("invalid_params", "harness"));
            }
            "claude-gateway" => return Err(refusal("module_session_refused", "session")),
            _ => {}
        }
        let mut runner = self.runners[bind.module.as_str()].clone();
        runner.state().file_provider = Some(CODE_PROVIDER.into());
        runner.call(&bind.session, op, params).await
    }

    async fn runner_next_unit(
        &self,
        _: &DreamScope,
        bind: &RunnerBind,
    ) -> Result<Option<Value>, PortError> {
        let mut runner = self.runners[bind.module.as_str()].clone();
        runner.next_unit(&bind.session).await
    }

    async fn runner_release(&self, _: &DreamScope, bind: &RunnerBind) {
        let mut runner = self.runners[bind.module.as_str()].clone();
        runner.release(&bind.session).await;
    }
}

// ---------------------------------------------------------------------------
// The carrier on its own, over the fixture's task context (a curate task).
// ---------------------------------------------------------------------------

struct CarrierRig {
    f: Fixture,
    wire: Arc<FakeWire>,
    parks: Arc<RoutedParks>,
    parked: Arc<AtomicU64>,
}

impl CarrierRig {
    fn new(candidates: Vec<Candidate>) -> Self {
        let f = Fixture::new(BASE);
        let wire = Arc::new(FakeWire::new(
            &f.handler,
            &f.context.config.directory,
            describe(BASE, 1_000_000, 600_000),
        ));
        wire.offer(candidates);
        wire.script(vec![answer("done")]);
        Self {
            f,
            wire,
            parks: Arc::default(),
            parked: Arc::default(),
        }
    }

    fn carrier_for(&self, task: TaskName) -> RoutedCarrier {
        let c = &self.f.context;
        let context = Arc::new(TaskContext {
            task,
            scope: c.scope.clone(),
            config: c.config.clone(),
            domain_lease: c.domain_lease.clone(),
            task_lease: c.task_lease.clone(),
            cancellation: c.cancellation.clone(),
            clock: c.clock.clone(),
            deadline_ms: c.deadline_ms,
            control: c.control.clone(),
        });
        RoutedCarrier::new(RoutedCarrierParts {
            wire: self.wire.clone(),
            routes: self.f.handler.broca_dream_tools(),
            context,
            router: self.f.effects.clone(),
            observer: self.f.effects.clone(),
            scheduler: self.f.scheduler.clone(),
            policy: policy(),
            project_id: EntorhinalProjectId::from_lookup_answer(ENTORHINAL_ID).unwrap(),
            parks: self.parks.clone(),
            parked: self.parked.clone(),
        })
    }

    /// One child with `tools`, opened, completed and closed.
    async fn child(&self, tools: &'static [&'static str]) -> Result<Completion, CarrierError> {
        self.child_for(self.f.context.task, tools).await
    }

    async fn child_for(
        &self,
        task: TaskName,
        tools: &'static [&'static str],
    ) -> Result<Completion, CarrierError> {
        let mut carrier = self.carrier_for(task);
        let request = self.f.request(tools, 5);
        bounded(async {
            let child = carrier.open(&request).await?;
            let completion = carrier.complete(&child, &request).await;
            carrier.close(&child, completion.is_ok()).await?;
            completion
        })
        .await
    }
}

/// The scope a dream child registers: ck-mc's own, Ephemeral, a fresh ref at
/// epoch 1, the project id Entorhinal answered and the run's folder, with no
/// parent and no attributes (no `agent_id`, no `delegates`).
#[tokio::test]
async fn routed_child_registers_a_parentless_project_scope_of_its_own() {
    let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
    let completion = rig.child(&[]).await.expect("completes");
    assert_eq!(completion.text, "done");
    let log = rig.wire.log();
    let scope = &log.syncs[0];
    assert_eq!(scope.record.kind, ScopeKind::Ephemeral);
    assert_eq!(scope.record.scope_epoch, 1);
    assert!(scope.scope_ref().starts_with("mc-dream-run:"));
    assert_eq!(scope.record.parent, None);
    assert!(
        scope.record.attributes.is_empty(),
        "{:?}",
        scope.record.attributes
    );
    assert_eq!(scope.record.attributes.agent_id, None);
    assert!(!scope.record.attributes.delegates);
    assert_eq!(scope.project_id.as_str(), ENTORHINAL_ID);
    assert_eq!(scope.workdir, rig.f.context.config.directory);
    // A child without tools lists no carrier.
    assert!(scope.record.carriers.is_empty());
    // The select went out under that scope, as the task's consumer.
    assert_eq!(log.selects[0].0, scope.scope_ref());
    assert_eq!(log.selects[0].1["consumer"], "mc.dream.curate");
    assert_eq!(log.selects[0].1["requirements"]["iq"], 70);
    assert_eq!(log.selects[0].1["requirements"]["tools"], "none");
    assert!(log.selects[0].1.get("project_id").is_none());
    // The scope ended with the child.
    assert_eq!(log.ends, [scope.scope_ref().to_owned()]);
}

/// Each run binds a fresh `mc-dream:<project_id>:<run>` session: a runner keys
/// sessions by name, so a reused name would land in an earlier run.
#[tokio::test]
async fn routed_children_bind_fresh_project_named_sessions() {
    let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
    rig.child(&[]).await.expect("first completes");
    rig.child(&[]).await.expect("second completes");
    let sessions: Vec<String> = rig
        .wire
        .sends()
        .into_iter()
        .map(|(_, b)| b.session)
        .collect();
    assert_eq!(sessions.len(), 2);
    assert_ne!(sessions[0], sessions[1]);
    for session in &sessions {
        let run = session
            .strip_prefix("mc-dream:pj-entorhinal:")
            .unwrap_or_else(|| panic!("{session}"));
        assert_eq!(run.len(), 32, "{session}");
    }
}

/// A child that calls tools lists the chosen runner's principal as the scope's
/// carrier, allowed to open routes only to the modules serving those tools, and
/// the runner's route is opened under that scope.
#[tokio::test]
async fn routed_tool_child_lists_the_chosen_runner_as_carrier() {
    let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
    rig.child(&["ctx_memory"]).await.expect("completes");
    let sends = rig.wire.sends();
    assert_eq!(sends.len(), 1);
    let (scope, bind) = &sends[0];
    assert_eq!(bind.module, "broca");
    let carriers = &scope.record.carriers;
    assert_eq!(carriers.len(), 1, "{carriers:?}");
    assert_eq!(
        carriers[0].principal,
        Principal::Reserved {
            module_id: "broca".into()
        }
    );
    assert_eq!(carriers[0].targets, Some(vec!["magic-context".to_owned()]));
    // The daemon learned of the carrier before the runner was asked anything.
    let log = rig.wire.log();
    let carried_sync = log
        .events
        .iter()
        .enumerate()
        .filter(|(_, e)| *e == "sync")
        .nth(1)
        .map(|(i, _)| i)
        .expect("the carrier was synced");
    let first_op = log
        .events
        .iter()
        .position(|e| e == "role.describe")
        .unwrap();
    assert!(carried_sync < first_op, "{:?}", log.events);
    assert_eq!(
        log.requirements_tools(),
        ["required"],
        "a tool child asks routing for a tool-capable route"
    );
}

impl WireLog {
    fn requirements_tools(&self) -> Vec<String> {
        self.selects
            .iter()
            .map(|(_, s)| s["requirements"]["tools"].as_str().unwrap().to_owned())
            .collect()
    }
}

#[tokio::test]
async fn routed_task_plans_request_capability_tags_not_modules() {
    for (task, tools, tags) in [
        (TaskName::Curate, &["ctx_memory"][..], vec!["mc.memory/v1"]),
        (TaskName::Classify, &[][..], vec![]),
        (TaskName::ReviewUserMemories, &[][..], vec![]),
        (
            TaskName::Map,
            &[
                "read",
                "grep",
                "glob",
                "aft_outline",
                "aft_zoom",
                "aft_search",
            ][..],
            vec!["code.read/v1"],
        ),
        (TaskName::Verify, &["read"][..], vec!["code.read/v1"]),
        (TaskName::VerifyBroad, &["read"][..], vec!["code.read/v1"]),
    ] {
        let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
        rig.child_for(task, tools).await.expect("completes");
        let log = rig.wire.log();
        let request = &log.selects[0].1;
        let got: Vec<String> = serde_json::from_value(
            request["requirements"]
                .get("tool_capabilities")
                .cloned()
                .unwrap_or(json!([])),
        )
        .unwrap();
        assert_eq!(got, tags, "{}", task.as_str());
        assert_eq!(request["consumer"], format!("mc.dream.{}", task.as_str()));
        assert_eq!(
            request["requirements"]["tools"],
            if tags.is_empty() { "none" } else { "required" }
        );
        if tags.is_empty() {
            assert!(log.capabilities.is_empty());
            assert!(log.plans[0].is_null());
        } else {
            assert_eq!(log.capabilities.as_slice(), std::slice::from_ref(&tags));
            let provider = if tags == ["code.read/v1"] {
                CODE_PROVIDER
            } else {
                "magic-context"
            };
            let plan = &log.plans[0];
            assert_eq!(plan["items"][0]["provider"], provider);
            assert_eq!(plan["items"][0]["params"]["tools"], json!(tools));
            let scope = &log.syncs[1];
            assert_eq!(
                scope.record.carriers[0].targets,
                Some(vec![provider.into()])
            );
            if provider == CODE_PROVIDER {
                assert_eq!(plan["items"][0]["params"]["root"], json!(scope.workdir));
            }
        }
    }
}

#[tokio::test]
async fn routed_two_tool_unavailable_refusals_stop_before_a_third_selection() {
    let rig = CarrierRig::new(vec![
        candidate("broca", "model-a", Some("claude-code")),
        candidate("broca", "model-b", Some("claude-code")),
        candidate("broca", "model-c", Some("claude-code")),
    ]);
    *rig.wire.tool_unavailable.lock().unwrap() = true;
    let error = rig.child_for(TaskName::Map, &["read"]).await.unwrap_err();
    assert!(
        error.message.starts_with("mc_dream_tool_unavailable:"),
        "{error:?}"
    );
    assert!(error.message.contains("code.read/v1"), "{error:?}");
    assert!(!error.retryable);
    let log = rig.wire.log();
    assert_eq!(log.selects.len(), 2, "only one retry is allowed");
    assert_eq!(log.plans.len(), 2);
    assert_eq!(log.selects[1].1["exclude"], json!(["vendor/model-a"]));
    assert_eq!(log.reports.len(), 2);
    for (_, report) in &log.reports {
        assert_eq!(report.outcome, Outcome::Refused);
        assert_eq!(report.runner_code.as_deref(), Some("tool_unavailable"));
    }
    assert_eq!(log.ends.len(), 1);
}

#[tokio::test]
async fn routed_old_routing_refuses_tool_tasks_but_not_no_tool_tasks() {
    let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
    *rig.wire.old_routing.lock().unwrap() = true;
    let error = rig.child_for(TaskName::Map, &["read"]).await.unwrap_err();
    assert!(
        error.message.starts_with("mc_route_misconfigured:"),
        "{error:?}"
    );
    assert!(rig.wire.sends().is_empty());
    rig.child_for(TaskName::Classify, &[])
        .await
        .expect("no-tool tasks still run");
    assert_eq!(rig.wire.sends().len(), 1);
}

#[tokio::test]
async fn routed_code_read_provider_refuses_path_escape() {
    let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
    let root = &rig.f.context.config.directory;
    let outside = tempfile::tempdir_in(root.parent().unwrap()).unwrap();
    let secret = outside.path().join("secret.txt");
    std::fs::write(&secret, "OUTSIDE-SECRET").unwrap();
    std::fs::write(root.join("inside.txt"), "INSIDE").unwrap();
    let traversal = format!(
        "../{}/secret.txt",
        outside.path().file_name().unwrap().to_string_lossy()
    );
    let calls = vec![
        ("read", json!({"filePath": "inside.txt"})),
        ("read", json!({"filePath": traversal})),
        ("read", json!({"filePath": secret})),
    ];
    #[cfg(unix)]
    let calls = {
        let mut calls = calls;
        std::os::unix::fs::symlink(&secret, root.join("escape.txt")).unwrap();
        calls.push(("read", json!({"filePath": "escape.txt"})));
        calls
    };
    rig.wire.script(vec![step(1, calls), answer("done")]);
    rig.child_for(TaskName::Map, &["read"])
        .await
        .expect("completes with refused tool results");
    let state = rig.wire.runners["broca"].state();
    assert_eq!(state.results[0].1["content"], "INSIDE");
    assert!(state.results.len() >= 3);
    for (_, result) in &state.results[1..] {
        assert_eq!(result["ok"], false, "{result}");
        assert_eq!(result["error"], "path_not_readable");
        assert!(result.get("content").is_none());
    }
    assert_eq!(rig.wire.log().capabilities, [["code.read/v1"]]);
}

/// When routing names the runner's hosted harness, the session is bound with
/// exactly that harness, and THALAMUS's OpenCode runner admits it.
#[tokio::test]
async fn routed_child_binds_the_harness_the_runner_declared() {
    let rig = CarrierRig::new(vec![candidate(
        "thalamus-harness",
        "model-a",
        Some("opencode"),
    )]);
    let completion = rig
        .child(&[])
        .await
        .expect("thalamus admits harness opencode");
    assert_eq!(completion.text, "done");
    let sends = rig.wire.sends();
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].1.module, "thalamus-harness");
    assert_eq!(sends[0].1.harness, "opencode");
    let log = rig.wire.log();
    assert_eq!(log.reports.len(), 1);
    assert_eq!(log.reports[0].1.outcome, Outcome::Completed);
}

/// A route whose runner declared no harness cannot be bound: it is reported as
/// unusable, excluded, and the next route is selected and bound.
#[tokio::test]
async fn routed_route_without_a_harness_is_excluded_and_the_next_is_bound() {
    let rig = CarrierRig::new(vec![
        candidate("broca", "model-a", None),
        candidate("broca", "model-b", Some("claude-code")),
    ]);
    rig.child(&[]).await.expect("the second route completes");
    let log = rig.wire.log();
    assert_eq!(log.reports.len(), 2);
    assert_eq!(log.reports[0].1.outcome, Outcome::Refused);
    assert_eq!(
        log.reports[0].1.runner_code.as_deref(),
        Some(HARNESS_UNKNOWN)
    );
    assert_eq!(log.selects[1].1["exclude"], json!(["vendor/model-a"]));
    // Only the bound route ever reached a runner.
    assert!(log
        .ops
        .iter()
        .all(|(_, bind, _)| bind.harness == "claude-code"));
    assert_eq!(log.reports[1].1.outcome, Outcome::Completed);
}

/// When no route routing can answer names a harness, the child is refused by
/// name and no runner is asked anything.
#[tokio::test]
async fn routed_child_with_no_declared_harness_is_refused_by_name() {
    let rig = CarrierRig::new(vec![
        candidate("broca", "model-a", None),
        candidate("thalamus-harness", "model-b", None),
    ]);
    let error = rig.child(&[]).await.unwrap_err();
    assert!(
        error.message.starts_with(HARNESS_UNKNOWN),
        "{}",
        error.message
    );
    assert_eq!(rig.wire.runner_ops(), 0);
    assert_eq!(rig.wire.log().reports.len(), 2);
}

/// A runner that refuses the parentless project session by name is reported
/// `refused` with its code, excluded, and the next route runs the child.
#[tokio::test]
async fn routed_runner_refusal_excludes_the_route_and_reselects() {
    let rig = CarrierRig::new(vec![
        candidate("claude-gateway", "model-a", Some("claude-code")),
        candidate("thalamus-harness", "model-b", Some("claude-code")),
        candidate("broca", "model-c", Some("claude-code")),
    ]);
    // Three decisions are allowed per child; the third route completes.
    let completion = rig.child(&[]).await.expect("broca completes");
    assert_eq!(completion.text, "done");
    let log = rig.wire.log();
    let reports: Vec<_> = log
        .reports
        .iter()
        .map(|(_, r)| (r.outcome.clone(), r.runner_code.clone()))
        .collect();
    assert_eq!(
        reports,
        [
            (Outcome::Refused, Some("module_session_refused".into())),
            // THALAMUS's OpenCode runner refuses a harness other than opencode.
            (Outcome::Refused, Some("invalid_params".into())),
            (Outcome::Completed, None),
        ]
    );
    assert_eq!(log.selects[1].1["exclude"], json!(["vendor/model-a"]));
    assert_eq!(
        log.selects[2].1["exclude"],
        json!(["vendor/model-a", "vendor/model-b"])
    );
    // Every select and report went out under the one scope of this child.
    let scope = log.syncs[0].scope_ref().to_owned();
    assert!(log.selects.iter().all(|(s, _)| *s == scope));
    assert!(log.reports.iter().all(|(s, _)| *s == scope));
}

// ---------------------------------------------------------------------------
// A classify task through the real dispatcher and executor.
// ---------------------------------------------------------------------------

struct Wall;
impl Clock for Wall {
    fn now_ms(&self) -> i64 {
        crate::now_ms()
    }
}

fn classify_answer() -> &'static str {
    Box::leak(
        format!(
            "<classify>{}</classify>",
            (1..=10)
                .map(|id| format!(
                    "<memory id=\"{id}\" importance=\"80\" scope=\"project\" shareable=\"false\" />"
                ))
                .collect::<String>()
        )
        .into_boxed_str(),
    )
}

fn seed_memories(store: &McStore, project: &str) {
    store
        .with_context_conn_for_test(|tx| {
            for id in 1..=10 {
                let content = format!("ARCHITECTURE entry {id} describes one durable fact.");
                tx.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,source_session_id,first_seen_at,created_at,updated_at,last_seen_at,metadata_json) VALUES (?1,?2,'ARCHITECTURE',?3,?4,'source',1,1,1,1,'{}')",
                    rusqlite::params![id, project, content, mc_store::compute_normalized_memory_hash(&content)])?;
            }
            Ok(())
        })
        .unwrap();
}

fn classified(store: &McStore) -> i64 {
    store
        .with_context_read(|db| {
            db.query_row(
                "SELECT COUNT(*) FROM memories WHERE classified_at IS NOT NULL",
                [],
                |r| r.get(0),
            )
        })
        .unwrap()
}

fn temp_root() -> tempfile::TempDir {
    let base = std::env::temp_dir().join("magic-context/s4-routed");
    std::fs::create_dir_all(&base).unwrap();
    tempfile::tempdir_in(base).unwrap()
}

fn dream_settings() -> Value {
    json!({"dreamer": {"tasks": {"classify-memories": {"schedule": "* * * * *"}}}})
}

struct ExecRig {
    _root: tempfile::TempDir,
    directory: PathBuf,
    project: String,
    store: Arc<McStore>,
    scheduler: Arc<SqliteDreamScheduler>,
    handler: Arc<McHandler>,
    wire: Arc<FakeWire>,
    parks: Arc<RoutedParks>,
}

impl ExecRig {
    fn new(candidates: Vec<Candidate>) -> Self {
        let root = temp_root();
        let directory = root.path().canonicalize().unwrap();
        let project = directory.to_string_lossy().into_owned();
        let store = Arc::new(
            McStore::open_for_test(&crate::dev_descriptor_at(root.path().to_str().unwrap()))
                .unwrap(),
        );
        seed_memories(&store, &project);
        let scheduler =
            Arc::new(SqliteDreamScheduler::open(root.path().join("scheduler.db"), true).unwrap());
        let handler = Arc::new(McHandler::new());
        let wire = Arc::new(FakeWire::new(
            &handler,
            &directory,
            describe(BASE, 1_000_000, 600_000),
        ));
        wire.offer(candidates);
        wire.script(vec![answer(classify_answer())]);
        Self {
            _root: root,
            directory,
            project,
            store,
            scheduler,
            handler,
            wire,
            parks: Arc::default(),
        }
    }

    fn lease_key(&self) -> String {
        TaskName::Classify.lease_key(&self.project)
    }

    fn scope(&self) -> StoreScope {
        StoreScope {
            project: ProjectId(self.project.clone()),
            session: SessionId(crate::dream_dispatch::tick::ROUTED_STORE_SESSION.into()),
            generation: Generation(1),
        }
    }

    /// One manual classify run, as the routed tick dispatches it.
    async fn dispatch(&self, command: &str) -> DispatchOutcome {
        let mut dispatcher = Dispatcher {
            store: self.store.clone(),
            scheduler: self.scheduler.clone(),
            scope: self.scope(),
            config: Arc::new(CapturedConfig {
                activated: true,
                route: McModuleConfig {
                    rust_background_enabled: true,
                    ..Default::default()
                },
                effective: dream_settings(),
                harness: String::new(),
                directory: self.directory.clone(),
            }),
            clock: Arc::new(Wall),
            executor: DreamExecutor::new(
                self.store.clone(),
                self.scheduler.clone(),
                Transport::<NoBroca>::Routed {
                    wire: self.wire.clone(),
                    routes: self.handler.broca_dream_tools(),
                    module_id: "magic-context".into(),
                    project_id: EntorhinalProjectId::from_lookup_answer(ENTORHINAL_ID).unwrap(),
                    parks: self.parks.clone(),
                },
                &[TaskName::Classify],
                crate::dream_dispatch::dispatcher::OPERATIONAL_TASKS,
            ),
        };
        let config = TaskConfig {
            task: TaskName::Classify,
            schedule: "* * * * *".into(),
            has_input: true,
            legacy_last_run_at: None,
        };
        tokio::time::timeout(
            Duration::from_secs(20),
            dispatcher.manual(
                &config,
                command,
                Duration::from_secs(30 * 60),
                Cancellation::default(),
            ),
        )
        .await
        .expect("routed dispatch timed out")
    }

    fn schedule(&self) -> Option<mc_store::dream_scheduler::schedules::ScheduleState> {
        match self.scheduler.schedule(&self.scope(), TaskName::Classify) {
            CapabilityResult::Available { value } => value,
            other => panic!("schedule unavailable: {other:?}"),
        }
    }

    /// Whether another holder could take the task's domain lease now. A lease
    /// taken to find out is given back at once.
    fn domain_free(&self) -> bool {
        let lease = self
            .store
            .acquire_dream_domain(&self.lease_key(), "probe", crate::now_ms())
            .unwrap();
        if let Some(lease) = &lease {
            self.store.release_dream_domain(lease).unwrap();
        }
        lease.is_some()
    }
}

/// select → send → report on the project-scoped route, and the task's effect
/// lands: a classify run through the production dispatcher and executor.
#[tokio::test]
async fn routed_classify_selects_sends_reports_and_lands() {
    let rig = ExecRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
    let outcome = rig.dispatch("command-1").await;
    assert_eq!(
        outcome,
        DispatchOutcome::Finished(ScheduleStatus::Completed),
        "{:?}",
        rig.wire.log().events
    );
    assert_eq!(classified(&rig.store), 10);
    let events = rig.wire.log().events.clone();
    let at = |name: &str| events.iter().position(|e| e == name).unwrap();
    assert!(at("sync") < at("select"), "{events:?}");
    assert!(at("select") < at("session.send"), "{events:?}");
    assert!(at("session.send") < at("report"), "{events:?}");
    assert!(at("report") < at("end"), "{events:?}");
    // Exactly the model routing answered, on the runner it named.
    let sends = rig.wire.runners["broca"].ops("session.send");
    assert_eq!(sends.len(), 1);
    assert_eq!(
        sends[0]["model"],
        json!({"provider": "vendor", "model": "model-a"})
    );
    let log = rig.wire.log();
    assert_eq!(log.selects[0].1["consumer"], "mc.dream.classify-memories");
    assert_eq!(log.reports.len(), 1);
    assert_eq!(log.reports[0].1.decision_id, "decision-1");
    assert_eq!(log.reports[0].1.outcome, Outcome::Completed);
    assert_eq!(log.syncs[0].project_id.as_str(), ENTORHINAL_ID);
    drop(log);
    // The leases were released at the end of the run.
    assert!(rig.domain_free());
}

/// The domain lease is held across a refusal and the re-select that follows,
/// for the whole task.
#[tokio::test]
async fn routed_leases_are_held_across_reselects() {
    let rig = ExecRig::new(vec![
        candidate("claude-gateway", "model-a", Some("claude-code")),
        candidate("broca", "model-b", Some("claude-code")),
    ]);
    let store = rig.store.clone();
    let key = rig.lease_key();
    *rig.wire.lease_probe.lock().unwrap() = Some(Box::new(move || {
        store
            .acquire_dream_domain(&key, "probe", crate::now_ms())
            .unwrap()
            .is_none()
    }));
    let outcome = rig.dispatch("command-1").await;
    assert_eq!(
        outcome,
        DispatchOutcome::Finished(ScheduleStatus::Completed)
    );
    assert_eq!(rig.wire.log().lease_held, [true, true]);
    assert_eq!(classified(&rig.store), 10);
}

/// A timed `no_route` parks the task: no send, both leases released, no
/// attempt recorded, and the task's consumer is not asked again before the
/// reset routing named.
#[tokio::test]
async fn routed_timed_refusal_parks_and_releases_the_leases() {
    let rig = ExecRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
    let reset = crate::now_ms() as u64 + 600_000;
    *rig.wire.timed_reset.lock().unwrap() = Some(reset);
    let outcome = rig.dispatch("command-1").await;
    let DispatchOutcome::Refused(reason) = &outcome else {
        panic!("expected a parked task, got {outcome:?}");
    };
    assert_eq!(
        reason,
        &format!("abandon:mc_route_waiting: until {reset}"),
        "{outcome:?}"
    );
    assert_eq!(rig.wire.runner_ops(), 0);
    assert!(rig.domain_free(), "the domain lease was released");
    // No attempt was recorded against the slot.
    if let Some(state) = rig.schedule() {
        assert_eq!(state.last_run_at, None);
        assert_eq!(state.last_status, None);
        assert_eq!(state.retry_count, 0);
    }
    // Asked again before the reset: parked without a select.
    let again = rig.dispatch("command-2").await;
    assert!(
        matches!(&again, DispatchOutcome::Refused(r) if r.starts_with("abandon:mc_route_waiting")),
        "{again:?}"
    );
    assert_eq!(rig.wire.log().selects.len(), 1);
    assert_eq!(rig.wire.log().reports.len(), 0);
}

/// Without a routing provider a dream run is refused by name, with no scope
/// registered, no select and no send.
#[tokio::test]
async fn routed_run_without_a_routing_provider_is_refused_by_name() {
    let mut rig = ExecRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
    Arc::get_mut(&mut rig.wire).unwrap().providers.clear();
    let outcome = rig.dispatch("command-1").await;
    assert_eq!(outcome, DispatchOutcome::Finished(ScheduleStatus::Failed));
    let error = rig
        .schedule()
        .and_then(|state| state.last_error)
        .unwrap_or_default();
    assert!(error.contains("routing_provider_missing"), "{error}");
    let log = rig.wire.log();
    assert!(log.syncs.is_empty() && log.selects.is_empty() && log.ops.is_empty());
    assert_eq!(classified(&rig.store), 0);
}

// ---------------------------------------------------------------------------
// The tick: which path a project takes, restarts, and Entorhinal's answer.
// ---------------------------------------------------------------------------

struct Resolver;

impl CoreConfigResolver for Resolver {
    fn availability(&self) -> Availability {
        Availability::Available
    }
    fn resolve(&self, _: &ConfigResolveRequest) -> CapabilityResult<CoreConfig> {
        CapabilityResult::Available {
            value: CoreConfig {
                effective: McModuleConfig {
                    rust_background_enabled: true,
                    ..Default::default()
                },
                generation: Generation(1),
                settings: dream_settings(),
                warnings: Vec::new(),
                trust: TrustFlags::default(),
                protected_token_tiers: ProtectedTokenTiers::default(),
            },
        }
    }
}

/// A ck-mc process over the store in `root`, with the Rust dreamer switched
/// on. Without `wire` it uses the production wire, which cannot register a
/// dream scope.
fn process(root: &Path) -> Arc<McHandler> {
    let store = Arc::new(
        McStore::open_for_test(&crate::dev_descriptor_at(root.to_str().unwrap())).unwrap(),
    );
    let mut handler = McHandler::new();
    assert!(handler.store.set(store).is_ok());
    handler.fixed_config = Some(McModuleConfig {
        rust_background_enabled: true,
        ..Default::default()
    });
    handler.fixed_dream_settings = Some(dream_settings());
    handler.dream_runs.use_resolver(Arc::new(Resolver));
    Arc::new(handler)
}

fn supporting_wire(handler: &Arc<McHandler>, directory: &Path) -> Arc<FakeWire> {
    let wire = Arc::new(FakeWire::new(
        handler,
        directory,
        describe(BASE, 1_000_000, 600_000),
    ));
    wire.offer(vec![candidate("broca", "model-a", Some("claude-code"))]);
    wire.script(vec![answer(classify_answer())]);
    handler.dream_runs.use_wire(wire.clone());
    wire
}

/// Serve a runner-lane conversation of the project: the project becomes a
/// dream target, in memory and in `dream_targets`.
fn serve(handler: &McHandler, project: &str, directory: &Path) {
    let principal = Principal::Reserved {
        module_id: "broca".into(),
    };
    let route =
        crate::route_targets::SessionRunnerRoute::for_principal(Some(&principal), "conversation")
            .unwrap();
    assert!(handler.record_session_runner_dream_target(project, directory, "claude-code", route));
}

fn manual_classify() -> Option<ManualRun> {
    Some(ManualRun {
        task: TaskName::Classify,
        command_id: format!("command-{}", crate::now_ms()),
    })
}

async fn finish(job: crate::dream_dispatch::tick::Job) -> RunReport {
    tokio::time::timeout(Duration::from_secs(20), async {
        while !job.is_finished() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("dream worker did not finish");
    job.join()
        .unwrap()
        .expect("config resolved")
        .expect("dreamer is on")
        .expect("run report")
}

// Routed tick fixtures share the production process-wide two-run limit. Keep
// independent tests from consuming one another's slots while their workers run.
static TICK_FIXTURES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Project {
    root: tempfile::TempDir,
    directory: PathBuf,
    key: String,
}

fn project() -> Project {
    let root = temp_root();
    let directory = root.path().canonicalize().unwrap();
    let key = directory.to_string_lossy().into_owned();
    Project {
        root,
        directory,
        key,
    }
}

fn store_of(handler: &McHandler) -> Arc<McStore> {
    handler.store.get().unwrap().clone()
}

/// The TypeScript scheduler's row for classify, due a minute ago, so the next
/// tick runs it.
fn due_now(store: &McStore, project: &str) {
    let due = (crate::now_ms() / 60_000 - 1) * 60_000;
    store
        .with_context_conn_for_test(|tx| {
            tx.execute_batch(&format!(
                "INSERT INTO task_schedule_state(project_path,task,next_due_at,schedule,retry_count) VALUES('{project}','classify-memories',{due},'* * * * *',0)"
            ))
        })
        .unwrap();
}

/// With the production wire (no dream scope possible) a project last seen on
/// a runner-lane conversation keeps today's path: here that path publishes
/// nothing (this process has no daemon connection to reach the conversation's
/// runner), exactly as before routed runs existed, and nothing is refused.
#[tokio::test]
async fn unsupported_scope_keeps_a_session_runner_project_on_its_old_path() {
    let _isolation = TICK_FIXTURES.lock().await;
    let p = project();
    let handler = process(p.root.path());
    seed_memories(&store_of(&handler), &p.key);
    serve(&handler, &p.key, &p.directory);
    let job = handler
        .dream_handles()
        .start(&p.key, manual_classify())
        .expect("a run starts");
    assert_eq!(finish(job).await, RunReport::new());
    assert_eq!(classified(&store_of(&handler)), 0);
}

/// The same project, where the scope can be registered, takes the routed path.
#[tokio::test]
async fn supported_scope_moves_the_same_project_to_the_routed_path() {
    let _isolation = TICK_FIXTURES.lock().await;
    let p = project();
    let handler = process(p.root.path());
    seed_memories(&store_of(&handler), &p.key);
    let wire = supporting_wire(&handler, &p.directory);
    serve(&handler, &p.key, &p.directory);
    let job = handler
        .dream_handles()
        .start(&p.key, manual_classify())
        .expect("a run starts");
    assert_eq!(
        finish(job).await,
        [(
            TaskName::Classify,
            DispatchOutcome::Finished(ScheduleStatus::Completed)
        )]
    );
    assert_eq!(classified(&store_of(&handler)), 10);
    assert_eq!(wire.log().lookups, std::slice::from_ref(&p.directory));
    assert_eq!(wire.sends().len(), 1);
}

/// In production a project only the routed path could carry (here: known only
/// from `dream_targets` after a restart) is refused by the scope refusal's
/// name, through the real start path, and nothing is sent.
#[tokio::test]
async fn unsupported_scope_refuses_a_routed_only_project_by_name() {
    let _isolation = TICK_FIXTURES.lock().await;
    let p = project();
    {
        let first = process(p.root.path());
        serve(&first, &p.key, &p.directory);
    }
    let restarted = process(p.root.path());
    let job = restarted
        .dream_handles()
        .start(&p.key, manual_classify())
        .expect("a run starts for the persisted project");
    assert_eq!(
        finish(job).await,
        [(
            TaskName::Classify,
            DispatchOutcome::Refused(SCOPE_UNSUPPORTED.into())
        )]
    );
    assert_eq!(classified(&store_of(&restarted)), 0);
}

/// A restart in the middle of a schedule: the first process served the project
/// and stopped before its due slot ran; the restarted process, which has not
/// served the project, ticks it from `dream_targets` and runs the slot.
#[tokio::test]
async fn a_restart_keeps_ticking_projects_from_dream_targets() {
    let _isolation = TICK_FIXTURES.lock().await;
    let p = project();
    {
        let first = process(p.root.path());
        seed_memories(&store_of(&first), &p.key);
        serve(&first, &p.key, &p.directory);
        due_now(&store_of(&first), &p.key);
    }
    let restarted = process(p.root.path());
    let wire = supporting_wire(&restarted, &p.directory);
    let handles = restarted.dream_handles();
    assert!(restarted.dream_runs.target_for_test(&p.key).is_none());
    assert_eq!(handles.due_projects(), std::slice::from_ref(&p.key));
    let mut jobs = handles.tick_once();
    assert_eq!(jobs.len(), 1);
    let report = finish(jobs.pop().unwrap()).await;
    assert_eq!(
        report,
        [(
            TaskName::Classify,
            DispatchOutcome::Finished(ScheduleStatus::Completed)
        )]
    );
    assert_eq!(classified(&store_of(&restarted)), 10);
    assert_eq!(wire.log().syncs[0].workdir, p.directory);
}

/// Entorhinal's answer right before the run wins over the id a previous run
/// stored, and the stored id is updated.
#[tokio::test]
async fn a_changed_entorhinal_answer_wins_over_the_stored_id() {
    let _isolation = TICK_FIXTURES.lock().await;
    let p = project();
    let handler = process(p.root.path());
    seed_memories(&store_of(&handler), &p.key);
    let wire = supporting_wire(&handler, &p.directory);
    serve(&handler, &p.key, &p.directory);
    let scheduler = crate::dream_dispatch::tick::open_scheduler(&store_of(&handler)).unwrap();
    scheduler.set_target_project_id(&p.key, "pj-stale").unwrap();
    let job = handler
        .dream_handles()
        .start(&p.key, manual_classify())
        .expect("a run starts");
    finish(job).await;
    let log = wire.log();
    assert!(!log.syncs.is_empty());
    assert!(log
        .syncs
        .iter()
        .all(|scope| scope.project_id.as_str() == ENTORHINAL_ID));
    drop(log);
    assert_eq!(
        scheduler
            .target(&p.key)
            .unwrap()
            .unwrap()
            .project_id
            .as_deref(),
        Some(ENTORHINAL_ID)
    );
}

/// Without a registered Entorhinal answer for the folder the run is skipped by
/// name: no scope, no select, no send.
#[tokio::test]
async fn a_folder_entorhinal_cannot_answer_skips_the_run_by_name() {
    let _isolation = TICK_FIXTURES.lock().await;
    let p = project();
    let handler = process(p.root.path());
    let wire = supporting_wire(&handler, &p.directory);
    wire.projects.lock().unwrap().clear();
    serve(&handler, &p.key, &p.directory);
    let job = handler
        .dream_handles()
        .start(&p.key, manual_classify())
        .expect("a run starts");
    assert_eq!(
        finish(job).await,
        [(
            TaskName::Classify,
            DispatchOutcome::Refused(PROJECT_UNRESOLVED.into())
        )]
    );
    let log = wire.log();
    assert!(log.syncs.is_empty() && log.selects.is_empty() && log.ops.is_empty());
}

#[tokio::test]
async fn routed_context_floor_covers_both_assembled_prompt_parts() {
    let rig = CarrierRig::new(vec![candidate("broca", "model-a", Some("claude-code"))]);
    let mut carrier = rig.carrier_for(rig.f.context.task);
    let mut request = rig.f.request(&[], 5);
    request.system = "alpha beta gamma delta ".repeat(1_000);
    request.prompt = "one two three four ".repeat(1_000);
    let child = carrier.open(&request).await.unwrap();
    carrier.complete(&child, &request).await.unwrap();
    carrier.close(&child, true).await.unwrap();
    assert!(
        rig.wire.log().selects[0].1["requirements"]["context_window"]
            .as_u64()
            .unwrap()
            > 4_000
    );
}
