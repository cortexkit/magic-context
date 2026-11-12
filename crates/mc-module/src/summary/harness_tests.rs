use super::*;
use crate::client::ClientError;
use cortexkit_role_compaction::read::{ReadPage, ReadRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::send::SendReply;
use cortexkit_role_routing::select::{SelectAnswer, SelectRequest};
use serde_json::json;
use std::sync::Mutex;

struct Client {
    runner: account_wait_send_tests::Client,
    routing: routing::Capabilities,
    declares: bool,
    selects: Mutex<Vec<Value>>,
    children: Mutex<Vec<SessionRef>>,
}

impl Client {
    fn new(declares: bool) -> Self {
        Self {
            runner: account_wait_send_tests::Client::new(
                account_wait_send_tests::Answer::RefuseSend,
            ),
            routing: routing::Capabilities::default(),
            declares,
            selects: Mutex::new(Vec::new()),
            children: Mutex::new(Vec::new()),
        }
    }
}

impl RunnerClient for Client {
    async fn read(
        &self,
        session: &SessionRef,
        request: ReadRequest,
    ) -> Result<ReadPage, ClientError> {
        self.runner.read(session, request).await
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
        self.children.lock().unwrap().push(child.session.clone());
        self.runner.send_child(child, request).await
    }

    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        unreachable!()
    }
}

impl Router for Client {
    async fn select(&self, request: SelectRequest) -> Result<SelectAnswer, routing::RouteError> {
        let request = self.routing.select_request("routing", 1, request, async {
            Ok(json!({"capabilities": if self.declares { vec!["select_harness"] } else { vec![] }}))
        }).await;
        self.selects
            .lock()
            .unwrap()
            .push(serde_json::to_value(&request).unwrap());
        self.runner.select(request).await
    }

    async fn report(&self, request: cortexkit_role_routing::report::ReportRequest) {
        self.runner.report(request).await;
    }
}

async fn selected(declares: bool, child_harness: Option<&str>) -> (Value, SessionRef) {
    let client = Client::new(declares);
    let mut job = account_wait_send_tests::job();
    job.session.harness = "opencode2".into();
    job.child_harness = child_harness.map(str::to_owned);
    // An account wait ends the run after its first child send, so this checks
    // the select and destination without needing a valid historian reply.
    assert!(matches!(
        run(&client, None, &job).await,
        Err(SummaryError::AccountWait(_))
    ));
    let mut selects = client.selects.lock().unwrap();
    let mut children = client.children.lock().unwrap();
    assert_eq!(selects.len(), 1);
    assert_eq!(children.len(), 1);
    (selects.remove(0), children.remove(0))
}

#[tokio::test]
async fn summary_select_names_setup_child_harness() {
    let (request, child) = selected(true, Some("claude-code")).await;
    assert_eq!(request["harness"], "claude-code");
    assert_eq!(child.harness, "claude-code");
    assert_eq!(request["runners"], json!(["runner"]));
}

#[tokio::test]
async fn summary_select_defaults_to_owner_harness() {
    let (request, child) = selected(true, None).await;
    assert_eq!(request["harness"], "opencode2");
    assert_eq!(child.harness, "opencode2");
}

#[tokio::test]
async fn summary_select_omits_harness_without_provider_capability() {
    for child_harness in [Some("claude-code"), None] {
        let (request, child) = selected(false, child_harness).await;
        assert!(request.get("harness").is_none(), "omit, do not send null");
        assert_eq!(child.harness, child_harness.unwrap_or("opencode2"));
    }
}

#[tokio::test]
async fn summary_select_harness_unavailable_remains_a_failure_not_a_wait() {
    let mut client = Client::new(true);
    client.runner = client.runner.with_route_refusal_after(
        0,
        routing::RouteError {
            code: "no_route".into(),
            message: "no compatible harness models".into(),
            detail: Some(json!({"reason": "harness_unavailable"})),
        },
    );
    let error = run(&client, None, &account_wait_send_tests::job())
        .await
        .expect_err("routing refused");
    assert!(matches!(error, SummaryError::Failed(_)), "{error:?}");
    assert_eq!(client.selects.lock().unwrap().len(), 1);
    assert!(client.children.lock().unwrap().is_empty());
}
