use super::*;
use crate::dream_dispatch::broca_carrier::{
    BrocaCarrier, BrocaPolicy, BrocaPort, BrocaToolRoute, PortError,
};
use crate::dream_dispatch::context::*;
use crate::dream_runner::{ChildRequest, DreamCarrier, ModelEntry, Usage};
use crate::historian_runner::{HistorianRunnerKind, ResolvedRunner, RunnerSource};
use mc_store::dream_domain::DreamDomainLease;
use mc_store::dream_scheduler::{
    budget::BudgetAction,
    schedules::{TaskConfig, TaskName},
    SqliteDreamScheduler,
};
use mc_store::parity_schema_manifest::*;

struct Controls;
impl Clock for Controls {
    fn now_ms(&self) -> i64 {
        60_000
    }
}
impl TaskControl for Controls {
    fn check_control(&self) -> Result<(), ControlError> {
        Ok(())
    }
    fn charge_usage(
        &self,
        _: &str,
        _: &Usage,
        _: bool,
        _: bool,
    ) -> Result<BudgetAction, ControlError> {
        Ok(BudgetAction::Continue)
    }
    fn refuse_tool(&self) -> Result<Option<(&'static str, bool)>, ControlError> {
        Ok(None)
    }
}
impl TaskToolRouter for Controls {
    fn execute(&self, _: &str, _: &str, _: &Value) -> Result<ToolResult, ToolError> {
        panic!("discovery must not execute a tool")
    }
}
impl ChildObserver for Controls {
    fn observe(&self, _: &str, _: ChildEvent) -> Result<(), ToolError> {
        Ok(())
    }
}

struct Port {
    description: Value,
    calls: Vec<(String, String, Value)>,
    released: Vec<String>,
}
impl BrocaPort for Port {
    async fn call(&mut self, session: &str, op: &str, params: Value) -> Result<Value, PortError> {
        self.calls.push((session.into(), op.into(), params));
        let answer = match op {
            "role.describe" => self.description.clone(),
            "session.send" => json!({"state":"active","run_id":"run-1"}),
            "run.status" => json!({"run_id":"run-1","state":"completed"}),
            "run.result" => {
                json!({"run_id":"run-1","state":"completed","final_ordinal":1,"final_message":{"ordinal":1,"mid":"answer","text":"done"}})
            }
            _ => panic!("unexpected dream operation: {op}"),
        };
        Ok(json!({"result":answer}))
    }
    async fn next_unit(&mut self, _: &str) -> Result<Option<Value>, PortError> {
        Ok(None)
    }
    async fn release(&mut self, session: &str) {
        self.released.push(session.into());
    }
    fn session_runner_parent(&self) -> Option<&str> {
        Some("parent")
    }
}

fn context(root: &Path, scheduler: &SqliteDreamScheduler) -> Arc<TaskContext> {
    let scope = StoreScope {
        project: ProjectId(root.to_string_lossy().into()),
        session: SessionId("parent".into()),
        generation: Generation(4),
    };
    let task = TaskName::Curate;
    let config = TaskConfig {
        task,
        schedule: "* * * * *".into(),
        has_input: true,
        legacy_last_run_at: None,
    };
    let result = scheduler.claim_task(
        &DreamClaimRequest {
            scope: scope.clone(),
            invocation: InvocationId("invocation".into()),
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
    );
    let CapabilityResult::Available { value: lease } = result else {
        panic!("task lease unavailable: {result:?}")
    };
    Arc::new(TaskContext {
        task,
        scope,
        config: Arc::new(CapturedConfig {
            activated: true,
            route: McModuleConfig::default(),
            effective: json!({}),
            harness: "opencode".into(),
            directory: root.into(),
        }),
        domain_lease: DreamDomainLease {
            key: "dreaming".into(),
            holder: "fixture".into(),
            generation: 1,
            expires_at_ms: 180_000,
        },
        task_lease: lease,
        cancellation: Cancellation::default(),
        clock: Arc::new(Controls),
        deadline_ms: 180_000,
        control: Arc::new(Controls),
    })
}

#[tokio::test]
async fn broca_role_describe_dream_child_admission_and_negotiated_send() {
    for (name, writer, description) in captures() {
        for tools in [&[][..], &["ctx_search"][..]] {
            for privacy_sensitive in [false, true] {
                let root = tempfile::tempdir().unwrap();
                let scheduler = Arc::new(
                    SqliteDreamScheduler::open(root.path().join("scheduler.db"), true).unwrap(),
                );
                let context = context(root.path(), &scheduler);
                let request = ChildRequest {
                    runner: ResolvedRunner {
                        kind: HistorianRunnerKind::Broca,
                        source: RunnerSource::Configured,
                    },
                    parent_session_id: "parent".into(),
                    directory: root.path().into(),
                    agent: "dreamer",
                    allowed_tools: tools,
                    max_steps: 3,
                    model: Some(ModelEntry {
                        model: "provider/model".into(),
                        qualifier: None,
                    }),
                    system: "system".into(),
                    prompt: "prompt".into(),
                    timeout: Duration::from_secs(10),
                    token_budget: Some(100),
                    temperature: None,
                };
                let routes = Arc::new(BrocaToolRoute::default());
                let mut carrier = BrocaCarrier::new(
                    Port {
                        description: description.clone(),
                        calls: Vec::new(),
                        released: Vec::new(),
                    },
                    routes.clone(),
                    context,
                    Arc::new(Controls),
                    Arc::new(Controls),
                    scheduler,
                    BrocaPolicy {
                        module_id: "magic-context".into(),
                        require_hard_cap: true,
                        privacy_sensitive,
                    },
                );
                let opened = carrier.open(&request).await;
                if !writer {
                    let failure = opened.unwrap_err();
                    assert_eq!(failure.message, "unavailable: retention", "{name}");
                    assert_eq!(
                        carrier.port().calls.len(),
                        1,
                        "{name}: refusal precedes send"
                    );
                    continue;
                }
                let child = opened.unwrap_or_else(|error| panic!("{name}: {error:?}"));
                assert!(routes.is_live(&child), "{name}");
                assert_eq!(
                    carrier.complete(&child, &request).await.unwrap().text,
                    "done",
                    "{name}"
                );
                carrier.close(&child, true).await.unwrap();
                assert!(!routes.is_live(&child), "{name}");
                let port = carrier.port();
                assert_eq!(
                    port.released.as_slice(),
                    std::slice::from_ref(&child),
                    "{name}"
                );
                assert!(
                    port.calls.iter().all(|(session, _, _)| session == &child),
                    "{name}: discovery and sends bind the child, not the parent"
                );
                let send = &port
                    .calls
                    .iter()
                    .find(|(_, op, _)| op == "session.send")
                    .unwrap()
                    .2;
                assert_eq!(
                    send["retention"],
                    if privacy_sensitive { 70 } else { 86_400 },
                    "{name}"
                );
                assert_eq!(send["stop_when"], json!({"max_steps":3}), "{name}");
                assert_eq!(send["budget"], json!({"max_input_tokens":100}), "{name}");
                if tools.is_empty() {
                    assert_eq!(send["tools"], json!([]), "{name}");
                }
            }
        }
    }
}
