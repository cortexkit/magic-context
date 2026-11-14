use std::collections::VecDeque;
use std::sync::Mutex;

use cortexkit_role_compaction::read::{ReadPage, ReadRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{
    states, FinalMessage, Finish, RunError, RunResult, RunResultRequest,
};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use cortexkit_role_routing::report::ReportRequest;
use cortexkit_role_routing::select::{RouteRef, RunnerRef, SelectAnswer, SelectRequest};
use serde_json::json;

use super::*;
use crate::client::ClientError;
use crate::routing::DREAM_DEMANDS;
use crate::runner_capabilities::SessionRetention;

/// How the runner ends one run.
#[derive(Clone)]
pub(crate) enum Ends {
    Reply(&'static str),
    /// A reply whose run reports this many input tokens used.
    Spent(&'static str, u64),
    Capped,
    Error(&'static str),
    /// Ends with routing's full capacity (`concurrency_full`) until this
    /// reset, the way an llm-runner 0.8.51 runner ends a queued run.
    Full(u64),
}

/// Routing offers `routes` in order, each on runner `rx` with harness `hx`
/// unless `no_harness` names it; an excluded route is skipped. `refuse`
/// answers every select with that refusal instead. The runner ends each run
/// with the next of `ends`, and declares `session_retention` with these
/// limits when `retention` is set.
pub(crate) struct Client {
    pub(crate) routes: Vec<&'static str>,
    pub(crate) no_harness: Vec<&'static str>,
    pub(crate) refuse: Option<routing::RouteError>,
    pub(crate) retention: Option<SessionRetention>,
    pub(crate) ends: Mutex<VecDeque<Ends>>,
    pub(crate) selects: Mutex<Vec<SelectRequest>>,
    pub(crate) reports: Mutex<Vec<String>>,
    pub(crate) sends: Mutex<Vec<(Child, SendRequest)>>,
    /// The runners that take fetch plans.
    pub(crate) plans: Vec<&'static str>,
    /// AFT's reader catalog, as (tool, capabilities), or why it isn't there.
    pub(crate) catalog: Result<Vec<(&'static str, &'static [&'static str])>, &'static str>,
    /// What Entorhinal answers every call with; `None` for no answer.
    pub(crate) entorhinal: Option<serde_json::Value>,
}

impl Client {
    pub(crate) fn new(routes: &[&'static str], ends: &[Ends]) -> Self {
        Self {
            routes: routes.to_vec(),
            no_harness: Vec::new(),
            refuse: None,
            retention: None,
            ends: Mutex::new(ends.iter().cloned().collect()),
            selects: Mutex::default(),
            reports: Mutex::default(),
            sends: Mutex::default(),
            plans: Vec::new(),
            catalog: Err("no reader in this test"),
            entorhinal: None,
        }
    }

    pub(crate) fn children(&self) -> Vec<String> {
        let sends = self.sends.lock().unwrap();
        sends
            .iter()
            .map(|(child, _)| child.session.session.clone())
            .collect()
    }
}

impl RunnerClient for Client {
    async fn entorhinal_call(
        &self,
        _: &SessionRef,
        _: Vec<u8>,
    ) -> Option<Result<Vec<u8>, crate::client::EntorhinalRefusal>> {
        let reply = self.entorhinal.as_ref()?;
        Some(Ok(serde_json::to_vec(reply).expect("a JSON reply")))
    }
    async fn child_plans(&self, child: &Child) -> bool {
        self.plans.contains(&child.session.runner.as_str())
    }
    async fn reader_catalog(
        &self,
        _: &Child,
    ) -> Result<cortexkit_role_tool_provider::catalog::CatalogAnswer, ClientError> {
        let tools = self.catalog.clone().map_err(ClientError::new)?;
        let mut answer = cortexkit_role_tool_provider::catalog::CatalogAnswer::default();
        answer.tools = tools
            .into_iter()
            .map(|(name, capabilities)| {
                let mut tool = cortexkit_role_tool_provider::catalog::CatalogTool::default();
                tool.name = name.into();
                tool.capabilities = capabilities.iter().map(|tag| (*tag).to_owned()).collect();
                tool
            })
            .collect();
        Ok(answer)
    }
    async fn child_session_retention(&self, _: &Child) -> Option<SessionRetention> {
        self.retention
    }
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        unreachable!()
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        unreachable!()
    }
    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        unreachable!()
    }
    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!()
    }
    async fn send_child(
        &self,
        child: &Child,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        self.sends.lock().unwrap().push((child.clone(), request));
        let mut reply = SendReply::new(states::ACTIVE);
        reply.run_id = Some("run".into());
        Ok(reply)
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        let ends = self
            .ends
            .lock()
            .unwrap()
            .pop_front()
            .expect("a scripted run end");
        Ok(match ends {
            Ends::Reply(text) => completed(text, None),
            Ends::Spent(text, tokens) => {
                let mut result = completed(text, None);
                let mut usage = cortexkit_role_llm_runner::usage::RunUsage::default();
                usage.steps = 1;
                usage.input_tokens = Some(tokens);
                result.usage = Some(usage);
                result
            }
            Ends::Capped => completed("{\"partial\":", Some(Finish::Length)),
            Ends::Error(message) => {
                let mut result = RunResult::new("run", states::ERROR);
                result.error = Some(RunError::new("provider", message, "provider_error"));
                result
            }
            Ends::Full(reset) => {
                let error = RunError::new(
                    "transient",
                    "every account on the route is at its concurrency cap",
                    cortexkit_role_llm_runner::errors::CONCURRENCY_FULL,
                )
                .with_resets_at_ms(reset);
                let mut result = RunResult::new("run", states::ERROR);
                result.awaits = Some(cortexkit_role_llm_runner::errors::ending_awaits(
                    &error,
                    now_ms() as u64,
                ));
                result.error = Some(error);
                result
            }
        })
    }
}

fn completed(text: &str, finish: Option<Finish>) -> RunResult {
    let mut result = RunResult::new("run", states::COMPLETED);
    result.finish = finish;
    result.final_message = Some(FinalMessage {
        ordinal: 1,
        mid: "answer".into(),
        text: text.into(),
    });
    result
}

impl Router for Client {
    async fn select(&self, request: SelectRequest) -> Result<SelectAnswer, routing::RouteError> {
        self.selects.lock().unwrap().push(request.clone());
        if let Some(refusal) = &self.refuse {
            return Err(refusal.clone());
        }
        let excluded = request.exclude.unwrap_or_default();
        let Some(route) = self
            .routes
            .iter()
            .find(|route| !excluded.iter().any(|x| x == *route))
        else {
            return Err(routing::RouteError {
                code: "no_route".into(),
                message: "every route excluded".into(),
                detail: None,
            });
        };
        let (provider, model) = route.split_once('/').unwrap();
        let reference = RouteRef::new(provider, model);
        let mut runner = RunnerRef::new(format!("r{model}"), reference.clone());
        if !self.no_harness.contains(route) {
            runner.harness = Some(format!("h{model}"));
        }
        Ok(SelectAnswer::new(
            format!("decision-{model}"),
            reference,
            runner,
            200_000,
            32_000,
            u64::MAX,
            "test",
        ))
    }
    async fn report(&self, request: ReportRequest) {
        let outcome = serde_json::to_value(&request.outcome).unwrap();
        self.reports.lock().unwrap().push(format!(
            "{} {}",
            request.decision_id,
            outcome.as_str().unwrap()
        ));
    }
}

/// A task whose input always fits, unless `fits` is false, and which
/// accepts only the reply `"ok"`.
struct Task {
    fits: bool,
}

impl TaskInput for Task {
    fn system(&self) -> &str {
        "You classify memories."
    }
    fn prompt(&self, window: Window, output_tokens: u64) -> Option<String> {
        self.fits
            .then(|| format!("{} {output_tokens}", window.context_window))
    }
    fn accepts(&self, reply: &str) -> Result<(), String> {
        if reply == "ok" {
            Ok(())
        } else {
            Err(format!("not ok: {reply}"))
        }
    }
}

fn classify() -> &'static DreamDemand {
    DREAM_DEMANDS
        .iter()
        .find(|demand| demand.kind == "classify-memories")
        .unwrap()
}

fn job() -> TaskRun<'static> {
    TaskRun {
        demand: classify(),
        run_id: "17",
        project_root: "/work/project",
    }
}

#[tokio::test(start_paused = true)]
async fn a_run_sends_the_task_to_a_child_of_its_own_where_routing_chose() {
    let client = Client::new(&["p/a"], &[Ends::Reply("ok")]);
    let reply = run(&client, &job(), &Task { fits: true }).await.unwrap();
    assert_eq!(reply.text, "ok");
    assert_eq!(reply.runner, "ra");
    assert_eq!(reply.child, "mc-dream:17:0.0");
    // The task kind's own consumer, at its demand, on no particular runner.
    let selects = client.selects.lock().unwrap();
    assert_eq!(selects[0].consumer, "magic-context.dream.classify-memories");
    assert_eq!(selects[0].runners, None);
    drop(selects);
    let sends = client.sends.lock().unwrap();
    let (child, request) = &sends[0];
    assert_eq!(child.session.runner, "ra");
    assert_eq!(child.session.harness, "ha");
    assert_eq!(child.project_root.as_deref(), Some("/work/project"));
    // The prompt is built for the chosen model's window and output.
    assert_eq!(request.prompt.as_deref(), Some("200000 32000"));
    assert_eq!(
        request.runner_params["system"],
        json!("You classify memories.")
    );
    assert_eq!(request.runner_params["tools"], json!([]));
    assert_eq!(request.runner_params["stop_when"], json!({"max_steps": 1}));
    assert!(request.plan.is_none());
    assert_eq!(request.route_decision_id.as_deref(), Some("decision-a"));
    drop(sends);
    assert_eq!(*client.reports.lock().unwrap(), ["decision-a completed"]);
}

#[tokio::test(start_paused = true)]
async fn an_unusable_or_cut_off_reply_moves_to_the_next_model() {
    let client = Client::new(
        &["p/a", "p/b", "p/c"],
        &[Ends::Reply("nonsense"), Ends::Capped, Ends::Reply("ok")],
    );
    let reply = run(&client, &job(), &Task { fits: true }).await.unwrap();
    assert_eq!(reply.runner, "rc");
    assert_eq!(
        client.children(),
        ["mc-dream:17:0.0", "mc-dream:17:1.0", "mc-dream:17:2.0"]
    );
    let selects = client.selects.lock().unwrap();
    assert_eq!(
        selects[2].exclude,
        Some(vec!["p/a".to_owned(), "p/b".to_owned()])
    );
    drop(selects);
    assert_eq!(
        *client.reports.lock().unwrap(),
        [
            "decision-a failed",
            "decision-b failed",
            "decision-c completed"
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn three_failed_models_fail_the_run_with_the_last_reason() {
    let client = Client::new(
        &["p/a", "p/b", "p/c", "p/d"],
        &[Ends::Reply("x"), Ends::Reply("y"), Ends::Reply("z")],
    );
    let error = run(&client, &job(), &Task { fits: true })
        .await
        .unwrap_err();
    assert!(
        matches!(&error, TaskError::Failed(reason) if reason.contains("not ok: z") && reason.contains("mc-dream:17:2.0")),
        "{error:?}"
    );
    assert_eq!(client.selects.lock().unwrap().len(), 3);
}

#[tokio::test(start_paused = true)]
async fn a_transient_error_retries_on_the_same_model_in_a_new_child() {
    let client = Client::new(&["p/a"], &[Ends::Error("overloaded"), Ends::Reply("ok")]);
    let reply = run(&client, &job(), &Task { fits: true }).await.unwrap();
    assert_eq!(reply.child, "mc-dream:17:0.1");
    assert_eq!(client.children(), ["mc-dream:17:0.0", "mc-dream:17:0.1"]);
    assert_eq!(*client.reports.lock().unwrap(), ["decision-a completed"]);
}

#[tokio::test(start_paused = true)]
async fn a_model_without_a_harness_or_room_for_the_input_is_passed_over_unsent() {
    let mut client = Client::new(&["p/a", "p/b"], &[Ends::Reply("ok")]);
    client.no_harness = vec!["p/a"];
    let reply = run(&client, &job(), &Task { fits: true }).await.unwrap();
    assert_eq!(reply.runner, "rb");
    assert_eq!(
        *client.reports.lock().unwrap(),
        ["decision-a cancelled", "decision-b completed"]
    );

    let client = Client::new(&["p/a", "p/b", "p/c"], &[]);
    let error = run(&client, &job(), &Task { fits: false })
        .await
        .unwrap_err();
    assert!(
        matches!(&error, TaskError::Failed(reason) if reason.contains("doesn't fit")),
        "{error:?}"
    );
    assert!(client.sends.lock().unwrap().is_empty());
    assert_eq!(client.reports.lock().unwrap().len(), 3);
}

#[tokio::test(start_paused = true)]
async fn a_routing_refusal_with_a_reset_time_is_a_wait_not_a_failure() {
    let mut client = Client::new(&["p/a"], &[]);
    client.refuse = Some(routing::RouteError {
        code: "no_route".into(),
        message: "every account is out".into(),
        detail: Some(json!({"reason": "quota_or_cooldown", "reset_at_ms": 4_000_000_000_000u64})),
    });
    let error = run(&client, &job(), &Task { fits: true })
        .await
        .unwrap_err();
    assert!(
        matches!(&error, TaskError::AccountWait(wait) if wait.send == SendKind::Dream),
        "{error:?}"
    );
    assert!(client.sends.lock().unwrap().is_empty());
}

/// Routing's refusal when every model slot is taken, with its reset when
/// given.
fn capacity_full(reset: Option<i64>) -> routing::RouteError {
    let mut detail = json!({"reason": "concurrency_full"});
    if let Some(reset) = reset {
        detail["reset_at_ms"] = json!(reset);
    }
    routing::RouteError {
        code: "no_route".into(),
        message: "every account on every adequate route is at its cap".into(),
        detail: Some(detail),
    }
}

/// Routing's full capacity ends the run as a wait, until routing's reset or
/// for the default five minutes when the refusal names none: no child
/// starts, and nothing counts against the task or a route.
#[tokio::test(start_paused = true)]
async fn a_full_capacity_refusal_is_a_wait_until_routing_s_reset() {
    use crate::summary::account_wait::DEFAULT_WAIT_MS;
    for reset in [Some(now_ms() + 10 * 60_000), None] {
        let mut client = Client::new(&["p/a"], &[]);
        client.refuse = Some(capacity_full(reset));
        let error = run(&client, &job(), &Task { fits: true })
            .await
            .unwrap_err();
        let TaskError::AccountWait(wait) = error else {
            panic!("full capacity failed the run: {error:?}");
        };
        assert_eq!(wait.code, "no_route:concurrency_full");
        assert_eq!(wait.send, SendKind::Dream);
        assert_eq!(wait.until_ms, reset.unwrap_or(wait.at_ms + DEFAULT_WAIT_MS));
        assert_eq!(client.selects.lock().unwrap().len(), 1);
        assert!(client.sends.lock().unwrap().is_empty());
        assert!(client.reports.lock().unwrap().is_empty());
    }
}

/// A run the runner ends with `concurrency_full` (llm-runner's
/// `errors::is_wait`) ends the task run as a wait until routing's reset: no
/// retry or other model, and routing hears the decision cancelled, not
/// failed.
#[tokio::test(start_paused = true)]
async fn a_run_ended_for_full_capacity_is_a_wait_not_a_failed_model() {
    let reset = now_ms() + 10 * 60_000;
    let client = Client::new(&["p/a", "p/b"], &[Ends::Full(reset as u64)]);
    let error = run(&client, &job(), &Task { fits: true })
        .await
        .unwrap_err();
    let TaskError::AccountWait(wait) = error else {
        panic!("full capacity failed the run: {error:?}");
    };
    assert_eq!(wait.code, "concurrency_full");
    assert_eq!(wait.until_ms, reset);
    assert_eq!(client.children(), ["mc-dream:17:0.0"]);
    assert_eq!(*client.reports.lock().unwrap(), ["decision-a cancelled"]);
}

fn verify() -> TaskRun<'static> {
    TaskRun {
        demand: DREAM_DEMANDS
            .iter()
            .find(|demand| demand.kind == "verify")
            .unwrap(),
        run_id: "18",
        project_root: "/work/project",
    }
}

/// A task that reads code gets AFT's reader tools through a fetch plan: no
/// inline system prompt or tool list, its text as the plan's text item, and
/// the kind's step bound.
#[tokio::test(start_paused = true)]
async fn a_code_reading_task_gets_the_reader_tools_through_a_plan() {
    let mut client = Client::new(&["p/a"], &[Ends::Reply("ok")]);
    client.plans = vec!["ra"];
    client.catalog = Ok(vec![("read", &["code.read/v1"]), ("grep", &[])]);
    let reply = run(&client, &verify(), &Task { fits: true }).await.unwrap();
    assert_eq!(reply.text, "ok");
    let sends = client.sends.lock().unwrap();
    let (_, request) = &sends[0];
    let plan = request.plan.as_ref().expect("a plan");
    assert_eq!(
        plan["tool_items"],
        json!([{"params": {}, "preset": "reader", "provider": "aft"}])
    );
    assert_eq!(
        plan["system_text_items"][0]["params"]["text"],
        json!("You classify memories.")
    );
    assert_eq!(
        plan["composition"]["providers"][0]["tools"],
        json!([
            {"capabilities": [], "name": "grep"},
            {"capabilities": ["code.read/v1"], "name": "read"},
        ])
    );
    assert!(request.runner_params.get("system").is_none());
    assert!(request.runner_params.get("tools").is_none());
    assert_eq!(request.runner_params["stop_when"], json!({"max_steps": 60}));
    assert!(request.cache.is_none());
}

/// A runner that takes no plan can't give the task tools: its model is
/// passed over unsent, and the next one runs.
#[tokio::test(start_paused = true)]
async fn a_runner_without_plans_is_passed_over() {
    let mut client = Client::new(&["p/a", "p/b"], &[Ends::Reply("ok")]);
    client.plans = vec!["rb"];
    client.catalog = Ok(vec![("read", &[])]);
    let reply = run(&client, &verify(), &Task { fits: true }).await.unwrap();
    assert_eq!(reply.runner, "rb");
    assert_eq!(client.children(), ["mc-dream:18:1.0"]);
    assert_eq!(
        *client.reports.lock().unwrap(),
        ["decision-a cancelled", "decision-b completed"]
    );
}

/// A reader catalog that could change the project, or none at all, fails the
/// run at once: no other model would get safe tools either.
#[tokio::test(start_paused = true)]
async fn unsafe_or_missing_reader_tools_fail_the_run_unsent() {
    for catalog in [
        Ok(vec![("read", &[][..]), ("bash", &[][..])]),
        Err("aft is down"),
    ] {
        let mut client = Client::new(&["p/a", "p/b"], &[]);
        client.plans = vec!["ra", "rb"];
        client.catalog = catalog;
        let error = run(&client, &verify(), &Task { fits: true })
            .await
            .unwrap_err();
        assert!(matches!(error, TaskError::Failed(_)), "{error:?}");
        assert!(client.sends.lock().unwrap().is_empty());
        assert_eq!(client.selects.lock().unwrap().len(), 1);
        assert_eq!(*client.reports.lock().unwrap(), ["decision-a cancelled"]);
    }
}

/// The `retention_policy` a declaring runner is sent to keep a child `days`
/// days.
fn kept(days: u32) -> serde_json::Value {
    json!({"keep": {"days": days}, "archive_after_days": 0, "backup": false, "request_dumps": false})
}

#[tokio::test(start_paused = true)]
async fn a_declaring_runner_is_asked_to_keep_every_dreamer_child_seven_days() {
    let mut client = Client::new(&["p/a"], &[Ends::Error("overloaded"), Ends::Reply("ok")]);
    client.retention = Some(SessionRetention { max_days: Some(30) });
    run(&client, &job(), &Task { fits: true }).await.unwrap();
    let sends = client.sends.lock().unwrap();
    // A retry runs in a new child, so its send creates that child too.
    assert_eq!(sends.len(), 2);
    for (_, request) in sends.iter() {
        assert_eq!(
            serde_json::to_value(request).unwrap()["retention_policy"],
            kept(7)
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_runner_allowing_three_days_is_asked_to_keep_a_dreamer_child_three() {
    let mut client = Client::new(&["p/a"], &[Ends::Reply("ok")]);
    client.retention = Some(SessionRetention { max_days: Some(3) });
    run(&client, &job(), &Task { fits: true }).await.unwrap();
    let sends = client.sends.lock().unwrap();
    assert_eq!(
        serde_json::to_value(&sends[0].1).unwrap()["retention_policy"],
        kept(3)
    );
}

#[tokio::test(start_paused = true)]
async fn a_later_send_in_a_dreamer_child_carries_no_policy() {
    let mut client = Client::new(&[], &[Ends::Reply("ok"), Ends::Reply("ok")]);
    client.retention = Some(SessionRetention { max_days: Some(30) });
    let model = ModelRef::new("p", "a");
    let child = Child {
        session: SessionRef::new("ra", "ha", child_session("17", 0, 0)),
        project_root: Some("/work/project".into()),
    };
    let mut how = Model {
        model: &model,
        decision_id: "decision-a",
        output_tokens: 1000,
        system: "You classify memories.",
        deadline: tokio::time::Instant::now() + RUN_TIMEOUT,
        continuation: false,
        creates_child: true,
        keep_child: true,
        send: SendKind::Dream,
        cache_ttl: cortexkit_role_llm_runner::cache::Ttl::Short,
        plan: None,
    };
    send_and_wait(&client, &child, "first", "prompt", &how, &mut None)
        .await
        .unwrap();
    how.continuation = true;
    how.creates_child = false;
    send_and_wait(&client, &child, "second", "follow-up", &how, &mut None)
        .await
        .unwrap();
    let sends = client.sends.lock().unwrap();
    assert_eq!(
        serde_json::to_value(&sends[0].1).unwrap()["retention_policy"],
        kept(7)
    );
    assert_eq!(sends[1].1.retention_policy, None);
    assert!(!serde_json::to_string(&sends[1].1)
        .unwrap()
        .contains("retention"));
}

#[tokio::test(start_paused = true)]
async fn a_runner_without_session_retention_gets_the_same_dreamer_send_bytes_as_before() {
    let client = Client::new(&["p/a"], &[Ends::Reply("ok")]);
    run(&client, &job(), &Task { fits: true }).await.unwrap();
    let sends = client.sends.lock().unwrap();
    // The bytes a dreamer child's creating send had before runners could be
    // asked to keep it, written out rather than rebuilt by the code under
    // test.
    assert_eq!(
        serde_json::to_string(&sends[0].1).unwrap(),
        r#"{"prompt":"200000 32000","send_id":"mc-dream:17:0.0","route_decision_id":"decision-a","generation":{"max_output_tokens":32000},"model":{"model":"a","provider":"p"},"stop_when":{"max_steps":1},"system":"You classify memories.","tools":[]}"#
    );
}
