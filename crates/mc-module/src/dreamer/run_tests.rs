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

/// How the runner ends one run.
#[derive(Clone)]
enum Ends {
    Reply(&'static str),
    Capped,
    Error(&'static str),
}

/// Routing offers `routes` in order, each on runner `rx` with harness `hx`
/// unless `no_harness` names it; an excluded route is skipped. `refuse`
/// answers every select with that refusal instead. The runner ends each run
/// with the next of `ends`.
struct Client {
    routes: Vec<&'static str>,
    no_harness: Vec<&'static str>,
    refuse: Option<routing::RouteError>,
    ends: Mutex<VecDeque<Ends>>,
    selects: Mutex<Vec<SelectRequest>>,
    reports: Mutex<Vec<String>>,
    sends: Mutex<Vec<(Child, SendRequest)>>,
}

impl Client {
    fn new(routes: &[&'static str], ends: &[Ends]) -> Self {
        Self {
            routes: routes.to_vec(),
            no_harness: Vec::new(),
            refuse: None,
            ends: Mutex::new(ends.iter().cloned().collect()),
            selects: Mutex::default(),
            reports: Mutex::default(),
            sends: Mutex::default(),
        }
    }

    fn children(&self) -> Vec<String> {
        let sends = self.sends.lock().unwrap();
        sends
            .iter()
            .map(|(child, _)| child.session.session.clone())
            .collect()
    }
}

impl RunnerClient for Client {
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
            Ends::Capped => completed("{\"partial\":", Some(Finish::Length)),
            Ends::Error(message) => {
                let mut result = RunResult::new("run", states::ERROR);
                result.error = Some(RunError::new("provider", message, "provider_error"));
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
