use super::*;
use crate::client::{Child, ClientError};
use cortexkit_role_routing::select::{RouteRef, RunnerRef, SelectAnswer, SelectRequest};

#[derive(Default)]
struct Trace {
    runner: Client,
    children: Mutex<Vec<(SessionRef, String)>>,
    selects: Mutex<Vec<SelectRequest>>,
    session_sends: Mutex<usize>,
    complete: bool,
}

struct SummaryClient(Arc<Trace>);

impl RunnerClient for SummaryClient {
    async fn read(
        &self,
        session: &SessionRef,
        request: ReadRequest,
    ) -> Result<ReadPage, ClientError> {
        self.0.runner.read(session, request).await
    }
    async fn apply_view(
        &self,
        session: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        self.0.runner.apply_view(session, request).await
    }
    async fn applied_view(&self, session: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        self.0.runner.applied_view(session).await
    }
    async fn send(
        &self,
        session: &SessionRef,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        *self.0.session_sends.lock().unwrap() += 1;
        self.0.runner.send(session, request).await
    }
    async fn send_child(
        &self,
        child: &Child,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        self.0.children.lock().unwrap().push((
            child.session.clone(),
            serde_json::to_string(&request).unwrap(),
        ));
        if self.0.complete {
            let mut reply = SendReply::new("active");
            reply.run_id = Some("summary-run".into());
            return Ok(reply);
        }
        Err(ClientError::refused(
            "account_limit_exhausted",
            "Account is waiting",
        ))
    }
    async fn child_result(
        &self,
        child: &Child,
        _: RunResultRequest,
    ) -> Result<RunResult, ClientError> {
        assert!(self.0.complete, "the send was refused before a run started");
        let pattern = regex::Regex::new(r":(\d+)-(\d+):").unwrap();
        let captures = pattern.captures(&child.session.session).unwrap();
        let (from, through) = (&captures[1], &captures[2]);
        let next = through.parse::<u64>().unwrap() + 1;
        let mut result = RunResult::new("summary-run", "completed");
        result.final_message = Some(cortexkit_role_llm_runner::run::FinalMessage {
            ordinal: 1, mid: "summary-answer".into(),
            // The summarizer's first-turn envelope; the session has no
            // project, so no second turn follows.
            text: mc_mock_runner::child::turn_one_reply(&format!("<output><compartments><compartment start=\"{from}\" end=\"{through}\" title=\"Earlier work\" episode_type=\"feature\" importance=\"50\"><p1>Completed earlier work.</p1><p2>Earlier work.</p2><p3>Work.</p3><p4 /></compartment></compartments><meta><unprocessed_from>{next}</unprocessed_from></meta></output>")),
        });
        Ok(result)
    }
}

impl crate::routing::Router for SummaryClient {
    async fn select(
        &self,
        request: SelectRequest,
    ) -> Result<SelectAnswer, crate::routing::RouteError> {
        let route = RouteRef::new("test", "summary-model");
        let runner = RunnerRef::new(request.runners.as_ref().unwrap()[0].clone(), route.clone());
        self.0.selects.lock().unwrap().push(request);
        Ok(SelectAnswer::new(
            "summary-decision",
            route,
            runner,
            400_000,
            32_000,
            u64::MAX,
            "test",
        ))
    }
    async fn report(&self, _: cortexkit_role_routing::report::ReportRequest) {}
}

#[tokio::test]
async fn wrapup_worker_starts_exactly_one_routed_child_and_status_reports_wait() {
    let (session, _, settings) = wrapup::ready();
    let (_, _, route, mut setup, _) = fixture();
    setup.preset = "head".into();
    setup.newest = session.index.entries().last().map(cursor);
    let trace = Arc::new(Trace::default());
    *trace.runner.entries.lock().unwrap() = session.index.entries().to_vec();
    let module = crate::module::Module::new(SummaryClient(trace.clone()), settings, None, None);
    module.setup(route, setup).unwrap();
    module.idle(&session.key).await.unwrap();
    *trace.session_sends.lock().unwrap() = 0;
    let caller = subc_protocol::Principal::Reserved {
        module_id: "occipital".into(),
    };
    let p = wrapup::request(&session, Some(2));
    let body = serde_json::to_vec(&json!({"method":"commands.preview", "params":p})).unwrap();
    let p: wire::Preview =
        serde_json::from_value(module.command_request(&caller, &body).await.unwrap()).unwrap();
    assert!(p.available, "{p:?}");
    let r = wire::ModuleRunRequest::new(
        wrapup::request(&session, Some(2)),
        p.version,
        "worker-wrapup",
    );
    let body = serde_json::to_vec(&json!({"method":"commands.run", "params":r})).unwrap();
    let answer = module.command_request(&caller, &body).await.unwrap();
    assert_eq!(answer["outcome"], "scheduled");
    module.idle(&session.key).await.unwrap();
    assert_eq!(
        module.command_request(&caller, &body).await.unwrap(),
        answer
    );
    module.idle(&session.key).await.unwrap();
    {
        let children = trace.children.lock().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].0.runner, session.key.runner);
        assert_eq!(children[0].0.harness, session.key.harness);
        assert!(
            children[0].1.contains("[22]") || children[0].1.contains("-22]"),
            "requested prefix reaches message 22"
        );
        assert!(
            !children[0].1.contains("[23]"),
            "newest prompt stays raw for keep=2"
        );
        assert_eq!(trace.selects.lock().unwrap().len(), 1);
        assert_eq!(
            *trace.session_sends.lock().unwrap(),
            0,
            "wrapup tells the agent nothing"
        );
    }
    let body = serde_json::to_vec(
        &json!({"method":"commands.preview", "params":preview_request(&session, "status")}),
    )
    .unwrap();
    let status = module.command_request(&caller, &body).await.unwrap();
    let status = status.to_string();
    assert!(status.contains("Wrapup target"));
    assert!(status.contains("Wrapup through"));
    assert!(status.contains("paused"));
}

#[tokio::test]
async fn wrapup_worker_drains_successive_runs_until_target_is_covered() {
    let (session, _, settings) = wrapup::ready();
    let (_, _, route, mut setup, _) = fixture();
    setup.preset = "head".into();
    let trace = Arc::new(Trace {
        complete: true,
        ..Default::default()
    });
    *trace.runner.entries.lock().unwrap() = (1..=600)
        .map(|ordinal| {
            Entry::new(
                ordinal,
                format!("m{ordinal}"),
                if ordinal % 2 == 1 {
                    Role::User
                } else {
                    Role::Assistant
                },
                ordinal,
                vec![Part::new(
                    "p",
                    PartBody::Text {
                        text: "a".repeat(400).into(),
                    },
                )],
            )
        })
        .collect();
    setup.newest = trace.runner.entries.lock().unwrap().last().map(cursor);
    let module = crate::module::Module::new(SummaryClient(trace.clone()), settings, None, None);
    module.setup(route, setup).unwrap();
    module.idle(&session.key).await.unwrap();
    let caller = subc_protocol::Principal::Reserved {
        module_id: "occipital".into(),
    };
    let body = serde_json::to_vec(
        &json!({"method":"commands.preview", "params":wrapup::request(&session, Some(0))}),
    )
    .unwrap();
    let p: wire::Preview =
        serde_json::from_value(module.command_request(&caller, &body).await.unwrap()).unwrap();
    assert!(p.available, "{p:?}");
    assert_eq!(p.facts.unwrap()[0].data.value, Some(600.0));
    let r = wire::ModuleRunRequest::new(wrapup::request(&session, Some(0)), p.version, "drain-all");
    let body = serde_json::to_vec(&json!({"method":"commands.run", "params":r})).unwrap();
    assert_eq!(
        module.command_request(&caller, &body).await.unwrap()["outcome"],
        "scheduled"
    );
    module.idle(&session.key).await.unwrap();
    assert!(
        trace.children.lock().unwrap().len() > 1,
        "success starts another capped run"
    );
    let body = serde_json::to_vec(
        &json!({"method":"commands.preview", "params":wrapup::request(&session, Some(0))}),
    )
    .unwrap();
    let p: wire::Preview =
        serde_json::from_value(module.command_request(&caller, &body).await.unwrap()).unwrap();
    assert_eq!(
        p.reason.as_deref(),
        Some("nothing_to_summarize"),
        "preview {p:?}; children {:?}",
        trace
            .children
            .lock()
            .unwrap()
            .iter()
            .map(|(child, _)| &child.session)
            .collect::<Vec<_>>()
    );
    let body = serde_json::to_vec(
        &json!({"method":"commands.preview", "params":preview_request(&session, "status")}),
    )
    .unwrap();
    assert!(!module
        .command_request(&caller, &body)
        .await
        .unwrap()
        .to_string()
        .contains("Wrapup target"));
}
